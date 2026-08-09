import type { GitLabJob, GitLabStatus } from '../gitlab/types.ts';
import type { CommitView, JobView, StageStatus, StageView } from '../shared/types.ts';

const PENDING_STATUSES = new Set<GitLabStatus>([
    'created',
    'pending',
    'preparing',
    'waiting_for_resource',
    'scheduled',
]);

const RUNNING_STATUSES = new Set<GitLabStatus>(['running', 'canceling']);

function toJobView(job: GitLabJob, retriedAttempts: number): JobView {
    return {
        id: job.id,
        name: job.name,
        stage: job.stage,
        status: job.status,
        allowFailure: job.allow_failure,
        durationSeconds: job.duration,
        webUrl: job.web_url,
        startedAt: job.started_at,
        finishedAt: job.finished_at,
        retriedAttempts,
    };
}

/**
 * Collapses retried attempts to the newest one per stage+name, mirroring what
 * GitLab shows in the pipeline graph.
 */
function latestAttempts(jobs: GitLabJob[]): { job: GitLabJob; retriedAttempts: number }[] {
    const byKey = new Map<string, { job: GitLabJob; retriedAttempts: number }>();

    for (const job of jobs) {
        const key = `${job.stage}\u0000${job.name}`;
        const existing = byKey.get(key);
        if (!existing) {
            byKey.set(key, { job, retriedAttempts: 0 });
            continue;
        }
        byKey.set(key, {
            job: job.id > existing.job.id ? job : existing.job,
            retriedAttempts: existing.retriedAttempts + 1,
        });
    }

    return [...byKey.values()];
}

/**
 * Worst-first precedence: an in-flight stage reads as running, a hard failure
 * outranks anything queued, and allow_failure-only failures degrade to a warning.
 */
export function aggregateStageStatus(jobs: JobView[]): StageStatus {
    if (jobs.length === 0) return 'skipped';

    const has = (predicate: (job: JobView) => boolean) => jobs.some(predicate);

    if (has((j) => RUNNING_STATUSES.has(j.status))) return 'running';
    if (has((j) => j.status === 'failed' && !j.allowFailure)) return 'failed';
    if (has((j) => PENDING_STATUSES.has(j.status))) return 'pending';
    if (has((j) => j.status === 'canceled')) return 'canceled';
    if (has((j) => j.status === 'manual')) return 'manual';
    if (has((j) => j.status === 'failed')) return 'warning';
    if (jobs.every((j) => j.status === 'skipped')) return 'skipped';
    return 'success';
}

/**
 * Stage order is derived from job id order: GitLab creates jobs stage by stage,
 * so the first attempt of each stage appears in pipeline order.
 */
export function buildStages(jobs: GitLabJob[]): StageView[] {
    const attempts = latestAttempts(jobs);
    const stageOrder = new Map<string, number>();

    for (const job of [...jobs].sort((a, b) => a.id - b.id)) {
        if (!stageOrder.has(job.stage)) stageOrder.set(job.stage, stageOrder.size);
    }

    const byStage = new Map<string, JobView[]>();
    for (const { job, retriedAttempts } of attempts) {
        const list = byStage.get(job.stage) ?? [];
        list.push(toJobView(job, retriedAttempts));
        byStage.set(job.stage, list);
    }

    return [...byStage.entries()]
        .sort(([a], [b]) => (stageOrder.get(a) ?? 0) - (stageOrder.get(b) ?? 0))
        .map(([name, stageJobs]) => {
            const ordered = stageJobs.sort((a, b) => a.name.localeCompare(b.name));
            return { name, status: aggregateStageStatus(ordered), jobs: ordered };
        });
}

/** Jobs carry the commit, so the board avoids a separate commits API call. */
export function extractCommit(jobs: GitLabJob[]): CommitView | null {
    const commit = jobs.find((job) => job.commit)?.commit;
    if (!commit) return null;
    return {
        shortId: commit.short_id,
        title: commit.title,
        authorName: commit.author_name,
    };
}
