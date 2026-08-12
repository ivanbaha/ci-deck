import { normaliseBaseUrl, validateToken } from '../config/env.ts';
import { resolveCredentials, type EnvLayers, type ResolvedCredentials } from '../config/resolve.ts';
import { Secrets } from '../config/secrets.ts';
import { GitLabClient } from '../gitlab/client.ts';
import { describeError, isAuthError } from '../gitlab/errors.ts';
import type { GitLabUser } from '../gitlab/types.ts';
import type { AppMeta, CredentialsInfo } from '../shared/types.ts';
import type { WatchStore } from '../store/watch-store.ts';
import { RequestLane } from './lane.ts';
import { Poller } from './poller.ts';
import { AppStore, repoViewFromRecord } from './state.ts';

export interface RuntimeOptions {
    watchStore: WatchStore;
    secrets: Secrets;
    layers: EnvLayers;
}

export interface ConfigureResult {
    username: string;
    storageLabel: string;
    storageSecure: boolean;
    /** Set when the OS credential store refused and plaintext was used. */
    warning?: string;
}

export class ConfigureError extends Error { }

interface Clients {
    sweep: GitLabClient;
    interactive: GitLabClient;
}

/**
 * Owns everything that depends on credentials. The board can boot unconfigured,
 * so clients and the poller are created on demand and swapped when the user
 * saves new credentials rather than requiring a restart.
 */
export class Runtime {
    readonly appStore: AppStore;
    private readonly watchStore: WatchStore;
    private readonly secrets: Secrets;
    private readonly layers: EnvLayers;
    private clients: Clients | null = null;
    private poller: Poller | null = null;
    private resolved: ResolvedCredentials | null = null;
    private username: string | null = null;
    private authError: string | null = null;
    private reachError: string | null = null;
    private storageWarning: string | null = null;

    constructor(options: RuntimeOptions) {
        this.watchStore = options.watchStore;
        this.secrets = options.secrets;
        this.layers = options.layers;

        const settings = options.watchStore.settings;
        this.appStore = new AppStore(
            {
                pollPeriodSeconds: settings.pollPeriodSeconds,
                retries: settings.retries,
                defaultRef: settings.defaultRef,
                confirmManualRun: settings.confirmManualRun,
                notifications: settings.notifications,
                theme: settings.theme,
                columnWidths: settings.columnWidths,
            },
            this.buildMeta(),
        );
    }

    /** Throws when the board is unconfigured — routes must surface that as 409. */
    get client(): GitLabClient {
        if (!this.clients) throw new ConfigureError('GitLab credentials are not configured yet');
        return this.clients.interactive;
    }

    get activePoller(): Poller {
        if (!this.poller) throw new ConfigureError('GitLab credentials are not configured yet');
        return this.poller;
    }

    get configured(): boolean {
        return this.clients !== null;
    }

    /**
     * Whether the sweep loop is still going. Distinct from `configured`: a token
     * GitLab rejected stops the loop while the clients stay in place, and asking
     * for a sweep in that state is a request nothing can honour.
     */
    get polling(): boolean {
        return this.poller?.active ?? false;
    }

    get baseUrl(): string | null {
        return this.resolved?.baseUrl.value ?? null;
    }

    private credentialsInfo(): CredentialsInfo {
        const resolved = this.resolved;
        const preferred = this.secrets.preferredProvider;

        const baseUrlLocked = resolved?.baseUrl.source === 'inline' || resolved?.baseUrl.source === 'file';
        const tokenLocked = resolved?.token.source === 'inline' || resolved?.token.source === 'file';

        return {
            complete: Boolean(resolved?.complete),
            baseUrl: {
                value: resolved?.baseUrl.value ?? null,
                source: resolved?.baseUrl.source ?? 'missing',
                locked: baseUrlLocked,
                error: resolved?.baseUrl.error ?? null,
            },
            token: {
                present: Boolean(resolved?.token.value),
                source: resolved?.token.source ?? 'missing',
                masked: resolved?.token.masked ?? null,
                storage: resolved?.token.storage ?? null,
                locked: tokenLocked,
                error: resolved?.token.error ?? null,
            },
            username: this.username,
            authError: this.authError,
            reachError: this.reachError,
            storageLabel: this.storageWarning ?? preferred.label,
            storageSecure: preferred.secure && this.storageWarning === null,
        };
    }

    private buildMeta(): AppMeta {
        return {
            gitlabBaseUrl: this.resolved?.baseUrl.value ?? null,
            user: this.username,
            storePath: this.watchStore.path,
            authError: this.authError,
            credentials: this.credentialsInfo(),
            polling: this.polling,
        };
    }

    private publishMeta(): void {
        this.appStore.setMeta(this.buildMeta());
    }

    private makeClients(baseUrl: string, token: string): Clients {
        const shared = {
            baseUrl,
            token,
            retry: { retries: this.watchStore.settings.retries },
            onRetry: ({ endpoint, attempt, delayMs, reason }: { endpoint: string; attempt: number; delayMs: number; reason: string }) =>
                console.warn(`retry ${attempt} on ${endpoint} in ${delayMs}ms — ${reason}`),
        };

        return {
            sweep: new GitLabClient({ ...shared, lane: new RequestLane({ maxConcurrent: 1, minGapMs: 50 }) }),
            interactive: new GitLabClient({ ...shared, lane: new RequestLane({ maxConcurrent: 4 }) }),
        };
    }

    /** Verifies a pair against GitLab before anything is stored or started. */
    private async verify(baseUrl: string, token: string): Promise<GitLabUser> {
        const probe = new GitLabClient({
            baseUrl,
            token,
            retry: { retries: 1 },
            lane: new RequestLane({ maxConcurrent: 1 }),
        });

        const user = await probe.getCurrentUser();
        if (!user?.username) {
            throw new ConfigureError(
                `${baseUrl} answered, but not like a GitLab API. Check the URL points at the instance root.`,
            );
        }
        return user;
    }

    /** Rows and tags travel together: a row without its tags cannot be filtered. */
    loadRepos(baseUrl: string): void {
        const tagsByRepo = this.watchStore.tagsByRepo(baseUrl);
        this.appStore.setRepos(
            this.watchStore
                .listReposFor(baseUrl)
                .map((record) => repoViewFromRecord(record, baseUrl, tagsByRepo.get(record.id) ?? [])),
        );
        this.appStore.setTags(this.watchStore.listTags(baseUrl));
    }

    /** Re-publishes tag counts after a membership change, without a full reload. */
    refreshTags(): void {
        const baseUrl = this.baseUrl;
        if (baseUrl) this.appStore.setTags(this.watchStore.listTags(baseUrl));
    }

    /**
     * Re-publishes both the tag list and every row's tags, leaving the live
     * GitLab data alone. Renaming or deleting a tag touches many rows at once,
     * and `loadRepos` would be the wrong tool: it rebuilds rows from the store,
     * which knows nothing about pipelines.
     */
    syncTags(baseUrl: string): void {
        this.appStore.setRepoTags(this.watchStore.tagsByRepo(baseUrl));
        this.appStore.setTags(this.watchStore.listTags(baseUrl));
    }

    private async startPolling(baseUrl: string, token: string): Promise<void> {
        await this.poller?.stop();

        this.clients = this.makeClients(baseUrl, token);
        this.poller = new Poller({
            client: this.clients.sweep,
            interactiveClient: this.clients.interactive,
            store: this.appStore,
            flags: this.watchStore,
        });

        this.loadRepos(baseUrl);
        this.poller.start();
    }

    /** Boots from whatever is already configured; never throws. */
    async bootstrap(): Promise<void> {
        this.resolved = await resolveCredentials(this.layers, this.watchStore, this.secrets);

        const { baseUrl, token } = this.resolved;
        if (!baseUrl.value || !token.value) {
            this.publishMeta();
            return;
        }

        try {
            this.username = (await this.verify(baseUrl.value, token.value)).username;
            this.authError = null;
            this.reachError = null;
            await this.startPolling(baseUrl.value, token.value);
        } catch (error) {
            const message = describeError(error);
            if (isAuthError(error) || error instanceof ConfigureError) {
                // Credentials are wrong: stay unconfigured and let the UI ask again.
                this.authError = message;
            } else {
                // The instance is unreachable; poll anyway so it recovers on its own.
                this.reachError = message;
                await this.startPolling(baseUrl.value, token.value);
            }
        }

        this.publishMeta();
    }

    /**
     * Validates and stores credentials, then swaps in fresh clients. Missing
     * fields fall back to whatever the environment already provides.
     */
    async configure(input: { baseUrl?: string; token?: string }): Promise<ConfigureResult> {
        const resolved = this.resolved ?? (await resolveCredentials(this.layers, this.watchStore, this.secrets));

        const baseUrl = input.baseUrl?.trim()
            ? normaliseBaseUrl(input.baseUrl)
            : resolved.baseUrl.value;
        if (!baseUrl) throw new ConfigureError('A GitLab URL is required');

        const token = input.token?.trim() ? validateToken(input.token) : resolved.token.value;
        if (!token) throw new ConfigureError('A personal access token is required');

        // A stored token belongs to the host it was stored for. Verifying sends it
        // to whatever URL arrives here, so re-pointing the board at another
        // instance has to come with that instance's token rather than reusing
        // this one — otherwise a single crafted request could post the PAT
        // anywhere. Tokens from the environment are the operator's own choice.
        const previous = resolved.baseUrl.value;
        if (previous && baseUrl !== previous && resolved.token.source === 'store' && !input.token?.trim()) {
            throw new ConfigureError(
                `The saved token is only ever sent to ${previous}. Enter the token for ${baseUrl} to switch.`,
            );
        }

        const user = await this.verify(baseUrl, token);

        // Only persist what the environment is not already dictating.
        const tokenFromEnv = resolved.token.source === 'inline' || resolved.token.source === 'file';
        this.storageWarning = null;

        if (!tokenFromEnv) {
            const outcome = await this.secrets.save(baseUrl, token);
            this.watchStore.saveCredential(baseUrl, outcome.stored, user.username);
            if (outcome.fellBackFrom) this.storageWarning = outcome.fellBackFrom;
        }

        this.watchStore.setActiveBaseUrl(baseUrl);

        this.username = user.username;
        this.authError = null;
        this.reachError = null;
        this.resolved = await resolveCredentials(this.layers, this.watchStore, this.secrets);

        await this.startPolling(baseUrl, token);
        this.publishMeta();

        const preferred = this.secrets.preferredProvider;
        return {
            username: user.username,
            storageLabel: this.storageWarning ? this.secrets.fallbackProvider.label : preferred.label,
            storageSecure: this.storageWarning ? false : preferred.secure,
            ...(this.storageWarning ? { warning: this.storageWarning } : {}),
        };
    }

    /** Removes the stored token and stops the board; the watch list is kept. */
    async forget(): Promise<void> {
        const baseUrl = this.resolved?.baseUrl.value;
        if (baseUrl) {
            const credential = this.watchStore.getCredential(baseUrl);
            if (credential) {
                await this.secrets.clear({ kind: credential.tokenKind, ref: credential.tokenRef });
                this.watchStore.deleteCredential(baseUrl);
            }
        }

        await this.poller?.stop();
        this.poller = null;
        this.clients = null;
        this.username = null;
        this.authError = null;
        this.reachError = null;

        this.resolved = await resolveCredentials(this.layers, this.watchStore, this.secrets);
        this.appStore.setRepos([]);
        this.publishMeta();
    }

    async stop(): Promise<void> {
        await this.poller?.stop();
        this.poller = null;
    }
}
