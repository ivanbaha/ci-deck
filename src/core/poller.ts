import type { GitLabClient } from '../gitlab/client.ts';
import { describeError, isAuthError } from '../gitlab/errors.ts';
import type { GitLabPipeline, GitLabStatus } from '../gitlab/types.ts';
import type { CommitView, PipelineView, RepoView, StageView } from '../shared/types.ts';
import { buildStages, extractCommit } from './stages.ts';
import type { AppStore } from './state.ts';

/** Gap between repos inside a sweep — keeps the request rate polite. */
export const DEFAULT_SPACING_MS = 200;

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

export interface PollerOptions {
    /** Sweep lane: serialised and paced. */
    client: GitLabClient;
    /** On-demand lane, used by user-triggered checks so they never queue behind a sweep. */
    interactiveClient?: GitLabClient;
    store: AppStore;
    spacingMs?: number;
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

/**
 * Walks the watch list one repo at a time, then waits out the poll period before
 * the next sweep. Sweeps never overlap: an overrunning sweep simply delays the
 * next one instead of stacking requests on GitLab.
 */
export class Poller {
    private readonly options: Required<Pick<PollerOptions, 'spacingMs' | 'sleep' | 'now'>> & PollerOptions;
    private readonly jobsCache = new Map<string, JobsCacheEntry>();
    private running = false;
    /** Set when polling must not continue: shutdown, or a token GitLab rejected. */
    private aborted = false;
    private loopPromise: Promise<void> | null = null;
    private wake: (() => void) | null = null;

    constructor(options: PollerOptions) {
        this.options = {
            spacingMs: DEFAULT_SPACING_MS,
            sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
            now: () => Date.now(),
            ...options,
        };
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
     * What this sweep will walk. Paused repos are refreshed on demand only, so
     * they cost nothing per pass — and when the sweep is scoped to the selected
     * tags, watching two hundred repos costs only the ones you are looking at,
     * which is the whole reason a serial sweep stays viable at that size.
     */
    private sweepTargets(): string[] {
        const { store } = this.options;
        const { activeTags, scopeSweepToTags } = store.getSettings();

        const candidates = scopeSweepToTags && activeTags.length > 0
            ? store.reposWithAnyTag(activeTags)
            : store.repoNames;

        return candidates.filter((name) => store.getRepo(name)?.watched !== false);
    }

    async sweepOnce(): Promise<void> {
        const { store, now, sleep, spacingMs } = this.options;
        const names = this.sweepTargets();
        const startedAt = now();

        store.setSweep({
            running: true,
            index: 0,
            total: names.length,
            currentRepo: null,
            startedAt: new Date(startedAt).toISOString(),
            finishedAt: null,
        });

        for (const [index, name] of names.entries()) {
            if (this.aborted) break;
            if (!store.getRepo(name)) continue;

            store.setSweep({ index: index + 1, currentRepo: name });
            await this.checkRepo(name, false);
            if (this.aborted) break;

            if (index < names.length - 1 && spacingMs > 0) await sleep(spacingMs);
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
    async refreshRepo(name: string): Promise<RepoView | undefined> {
        await this.checkRepo(name, true);
        return this.options.store.getRepo(name);
    }

    invalidate(name: string): void {
        this.jobsCache.delete(name);
    }

    private async checkRepo(name: string, interactive: boolean): Promise<void> {
        const { store } = this.options;
        const repo = store.getRepo(name);
        if (!repo) return;

        const force = interactive;
        const client = interactive
            ? this.options.interactiveClient ?? this.options.client
            : this.options.client;

        store.patchRepo(name, { checking: true });

        try {
            const pipeline = await client.getLatestPipeline(repo.projectId, repo.ref);
            const checkedAt = new Date(this.options.now()).toISOString();

            if (!pipeline) {
                this.jobsCache.delete(name);
                store.patchRepo(name, {
                    health: 'no-pipeline',
                    pipeline: null,
                    stages: [],
                    lastCheckedAt: checkedAt,
                    lastError: null,
                    checking: false,
                });
                return;
            }

            const cached = this.jobsCache.get(name);
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
                this.jobsCache.set(name, {
                    pipelineId: pipeline.id,
                    updatedAt: pipeline.updated_at,
                    status: pipeline.status,
                    stages,
                    commit,
                });
            }

            store.patchRepo(name, {
                webUrl: repo.webUrl ?? projectUrlFromPipeline(pipeline.web_url),
                health: 'ok',
                pipeline: toPipelineView(pipeline, commit),
                stages,
                lastCheckedAt: checkedAt,
                lastError: null,
                checking: false,
            });
        } catch (error) {
            const message = describeError(error);
            store.patchRepo(name, {
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
