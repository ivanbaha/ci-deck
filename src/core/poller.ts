import type { GitLabClient } from '../gitlab/client.ts';
import { describeError, isAuthError } from '../gitlab/errors.ts';
import type { GitLabPipeline, GitLabStatus } from '../gitlab/types.ts';
import type { CommitView, NotifyMode, PipelineView, RepoView, StageView } from '../shared/types.ts';
import { buildStages, extractCommit } from './stages.ts';
import type { AppStore } from './state.ts';

/** Gap between repos inside a sweep — keeps the request rate polite. */
export const DEFAULT_SPACING_MS = 200;

/**
 * How often a row watching something other than the default branch asks whether
 * that branch is still there. Once a sweep would be an extra request per repo per
 * pass for an answer that changes about once in a repo's lifetime.
 */
export const BRANCH_CHECK_INTERVAL_MS = 5 * 60_000;

interface JobsCacheEntry {
    pipelineId: number;
    updatedAt: string;
    status: GitLabStatus;
    stages: StageView[];
    commit: CommitView | null;
}

/**
 * Pipeline states after which no job can change again. GitLab does not reliably
 * bump a pipeline's `updated_at` on every single job transition, so anything not
 * listed here has its jobs refetched on every check.
 */
const SETTLED_STATUSES = new Set<GitLabStatus>(['success', 'failed', 'canceled', 'skipped']);

/**
 * A pipeline in one of these is still going to change on its own. Everything else
 * is a result — `manual` included, which is GitLab saying it has stopped and is
 * waiting for a person.
 */
const IN_FLIGHT_STATUSES = new Set<GitLabStatus>([
    'created',
    'waiting_for_resource',
    'waiting_for_callback',
    'preparing',
    'pending',
    'running',
    'scheduled',
    'canceling',
]);

/** Where a branch that has gone missing is recorded, so a restart still shows it. */
export interface RepoFlagSink {
    setBranchMissing(id: number, missing: boolean): void;
}

export interface PollerOptions {
    /** Sweep lane: serialised and paced. */
    client: GitLabClient;
    /** On-demand lane, used by user-triggered checks so they never queue behind a sweep. */
    interactiveClient?: GitLabClient;
    store: AppStore;
    flags?: RepoFlagSink;
    spacingMs?: number;
    branchCheckIntervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
}

function projectUrlFromPipeline(webUrl: string): string | null {
    const marker = webUrl.indexOf('/-/');
    return marker === -1 ? null : webUrl.slice(0, marker);
}

function toPipelineView(pipeline: GitLabPipeline, commit: CommitView | null): PipelineView {
    return {
        id: pipeline.id,
        iid: pipeline.iid,
        status: pipeline.status,
        ref: pipeline.ref,
        sha: pipeline.sha,
        source: pipeline.source,
        webUrl: pipeline.web_url,
        createdAt: pipeline.created_at,
        updatedAt: pipeline.updated_at,
        commit,
    };
}

/** Hard failures only: an allow_failure job is why a stage is amber, not red. */
function failedJobNames(stages: StageView[]): string[] {
    return stages.flatMap((stage) =>
        stage.jobs.filter((job) => job.status === 'failed' && !job.allowFailure).map((job) => job.name),
    );
}

/**
 * Whether a finished pipeline gets announced, and whether it makes a sound. The
 * global setting is a ceiling rather than a default: turning it to `snooze`
 * quiets every row at once without editing any of them.
 */
export function resolveNotifyMode(global: NotifyMode, repo: NotifyMode): NotifyMode {
    if (global === 'off' || repo === 'off') return 'off';
    if (global === 'snooze' || repo === 'snooze') return 'snooze';
    return 'on';
}

/**
 * Walks the watch list one repo at a time, then waits out the poll period before
 * the next sweep. Sweeps never overlap: an overrunning sweep simply delays the
 * next one instead of stacking requests on GitLab.
 */
export class Poller {
    private readonly options: Required<Pick<PollerOptions, 'spacingMs' | 'sleep' | 'now' | 'branchCheckIntervalMs'>> & PollerOptions;
    private readonly jobsCache = new Map<number, JobsCacheEntry>();
    private readonly branchCheckedAt = new Map<number, number>();
    private running = false;
    /** Set when polling must not continue: shutdown, or a token GitLab rejected. */
    private aborted = false;
    private loopPromise: Promise<void> | null = null;
    private wake: (() => void) | null = null;

    constructor(options: PollerOptions) {
        this.options = {
            spacingMs: DEFAULT_SPACING_MS,
            branchCheckIntervalMs: BRANCH_CHECK_INTERVAL_MS,
            sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
            now: () => Date.now(),
            ...options,
        };
    }

    /**
     * False once the loop has stopped for good. A token GitLab rejected ends it
     * mid-sweep and nothing here can restart it — new credentials build a new
     * poller — so callers have to be able to tell, rather than reporting a sweep
     * they only asked for.
     */
    get active(): boolean {
        return this.running && !this.aborted;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        this.aborted = false;
        this.loopPromise = this.loop();
    }

    async stop(): Promise<void> {
        this.running = false;
        this.aborted = true;
        this.wake?.();
        await this.loopPromise?.catch(() => undefined);
        this.loopPromise = null;
    }

    /** Cuts the current wait short so the next sweep starts now. */
    trigger(): void {
        this.wake?.();
    }

    private async loop(): Promise<void> {
        while (this.running && !this.aborted) {
            await this.sweepOnce();
            if (!this.running || this.aborted) break;

            const periodMs = this.options.store.getSettings().pollPeriodSeconds * 1_000;
            this.options.store.setSweep({ nextRunAt: new Date(this.options.now() + periodMs).toISOString() });
            await this.waitForNext(periodMs);
        }
    }

    private waitForNext(ms: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                this.wake = null;
                resolve();
            }, ms);
            this.wake = () => {
                clearTimeout(timer);
                this.wake = null;
                resolve();
            };
        });
    }

    /**
     * What this sweep will walk, and in what order. Paused repos are refreshed on
     * demand only, so they cost nothing per pass. Everything else is covered every
     * time — the rows the board is showing simply go first, so a search narrows
     * what you wait for without narrowing what you are told about.
     */
    private sweepTargets(): number[] {
        const { store } = this.options;
        return store.sweepOrder().filter((id) => store.getRepo(id)?.watched !== false);
    }

    async sweepOnce(): Promise<void> {
        const { store, now, sleep, spacingMs } = this.options;
        const ids = this.sweepTargets();
        const startedAt = now();

        store.setSweep({
            running: true,
            index: 0,
            total: ids.length,
            currentRepo: null,
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: null,
        });

        for (const [index, id] of ids.entries()) {
            if (this.aborted) break;
            const repo = store.getRepo(id);
            if (!repo) continue;

            store.setSweep({ index: index + 1, currentRepo: repo.name });
            await this.checkRepo(id, false);
            if (this.aborted) break;

            if (index < ids.length - 1 && spacingMs > 0) await sleep(spacingMs);
        }

        const finishedAt = now();
        store.setSweep({
            running: false,
            currentRepo: null,
            finishedAt: new Date(finishedAt).toISOString(),
            lastDurationMs: finishedAt - startedAt,
        });
    }

    /**
     * Checks one repo right now, bypassing the jobs cache and the sweep lane, so a
     * user waiting on a row is never stuck behind the rest of the watch list.
     */
    async refreshRepo(id: number): Promise<RepoView | undefined> {
        await this.checkRepo(id, true);
        return this.options.store.getRepo(id);
    }

    invalidate(id: number): void {
        this.jobsCache.delete(id);
        this.branchCheckedAt.delete(id);
    }

    /**
     * Asks whether the branch is still on GitLab, for rows watching something
     * other than the board's default. A branch that was merged and deleted leaves
     * a row that can never go green again, and the honest thing is to say so
     * rather than to let it sit there looking merely quiet.
     */
    private async checkBranch(repo: RepoView, client: GitLabClient, force: boolean): Promise<void> {
        const { store, flags, now, branchCheckIntervalMs } = this.options;
        if (repo.ref === store.getSettings().defaultRef) return;

        const last = this.branchCheckedAt.get(repo.id);
        if (!force && last !== undefined && now() - last < branchCheckIntervalMs) return;

        // Any other failure is the instance being unreachable, which the pipeline
        // fetch right after this reports properly. Nothing is claimed from it.
        const exists = await client.branchExists(repo.projectId, repo.ref).catch(() => true);
        this.branchCheckedAt.set(repo.id, now());

        if (exists === repo.branchMissing) {
            store.patchRepo(repo.id, { branchMissing: !exists });
            flags?.setBranchMissing(repo.id, !exists);
        }
    }

    /**
     * Announces a pipeline that was in flight and has stopped being in flight.
     * Only that transition: a pipeline already finished when the board first saw
     * it was never being waited on, and saying so on every restart would make the
     * whole thing noise.
     */
    private announce(before: RepoView, after: PipelineView, stages: StageView[]): void {
        const previous = before.pipeline;
        if (!previous || previous.id !== after.id) return;
        if (!IN_FLIGHT_STATUSES.has(previous.status) || IN_FLIGHT_STATUSES.has(after.status)) return;

        const mode = resolveNotifyMode(this.options.store.getSettings().notifications, before.notify);
        if (mode === 'off') return;

        this.options.store.notify({
            repoId: before.id,
            repo: before.name,
            ref: before.ref,
            status: after.status,
            pipelineIid: after.iid,
            webUrl: after.webUrl,
            silent: mode === 'snooze',
            failedJobs: failedJobNames(stages),
        });
    }

    private async checkRepo(id: number, interactive: boolean): Promise<void> {
        const { store } = this.options;
        const repo = store.getRepo(id);
        if (!repo) return;

        const force = interactive;
        const client = interactive
            ? this.options.interactiveClient ?? this.options.client
            : this.options.client;

        store.patchRepo(id, { checking: true });

        try {
            await this.checkBranch(repo, client, force);

            const pipeline = await client.getLatestPipeline(repo.projectId, repo.ref);
            const checkedAt = new Date(this.options.now()).toISOString();

            if (!pipeline) {
                this.jobsCache.delete(id);
                store.patchRepo(id, {
                    health: 'no-pipeline',
                    pipeline: null,
                    stages: [],
                    lastCheckedAt: checkedAt,
                    lastError: null,
                    checking: false,
                });
                return;
            }

            const cached = this.jobsCache.get(id);
            const reusable = !force
                && SETTLED_STATUSES.has(pipeline.status)
                && cached?.pipelineId === pipeline.id
                && cached.status === pipeline.status
                && cached.updatedAt === pipeline.updated_at;

            let stages: StageView[];
            let commit: CommitView | null;

            if (reusable) {
                stages = cached.stages;
                commit = cached.commit;
            } else {
                const jobs = await client.getPipelineJobs(repo.projectId, pipeline.id);
                stages = buildStages(jobs);
                commit = extractCommit(jobs);
                this.jobsCache.set(id, {
                    pipelineId: pipeline.id,
                    updatedAt: pipeline.updated_at,
                    status: pipeline.status,
                    stages,
                    commit,
                });
            }

            const view = toPipelineView(pipeline, commit);
            // Before the patch, because the comparison is against what the board
            // last knew and the patch is what replaces it.
            this.announce(repo, view, stages);

            store.patchRepo(id, {
                webUrl: repo.webUrl ?? projectUrlFromPipeline(pipeline.web_url),
                health: 'ok',
                pipeline: view,
                stages,
                lastCheckedAt: checkedAt,
                lastError: null,
                checking: false,
            });
        } catch (error) {
            const message = describeError(error);
            store.patchRepo(id, {
                health: 'unreachable',
                lastCheckedAt: new Date(this.options.now()).toISOString(),
                lastError: message,
                checking: false,
            });

            if (isAuthError(error)) {
                store.setAuthError(message);
                this.running = false;
                this.aborted = true;
            }
        }
    }
}
