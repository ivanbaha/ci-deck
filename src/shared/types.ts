import type { GitLabStatus } from '../gitlab/types.ts';

export type { GitLabStatus };

/** Status shown on a stage bubble. `warning` = only allow_failure jobs failed. */
export type StageStatus =
    | 'running'
    | 'failed'
    | 'pending'
    | 'canceled'
    | 'manual'
    | 'warning'
    | 'skipped'
    | 'success';

export type RepoHealth = 'ok' | 'no-pipeline' | 'unreachable' | 'unknown';

export interface JobView {
    id: number;
    name: string;
    stage: string;
    status: GitLabStatus;
    allowFailure: boolean;
    durationSeconds: number | null;
    webUrl: string;
    startedAt: string | null;
    finishedAt: string | null;
    /** Superseded attempts of the same job name in this pipeline. */
    retriedAttempts: number;
}

export interface StageView {
    name: string;
    status: StageStatus;
    jobs: JobView[];
}

export interface CommitView {
    shortId: string;
    title: string;
    authorName: string;
}

export interface PipelineView {
    id: number;
    iid: number;
    status: GitLabStatus;
    ref: string;
    sha: string;
    source: string;
    webUrl: string;
    createdAt: string;
    updatedAt: string;
    commit: CommitView | null;
}

export interface RepoView {
    name: string;
    /** Namespace the repo sits in — what the board files it under. */
    group: string;
    /** Hand-curated labels, overlapping and many-to-many. Filtering only. */
    tags: string[];
    /** Resolved when the repo was added, so sweeps never look it up again. */
    projectId: number;
    ref: string;
    /** False keeps the row on the board but out of the periodic sweep. */
    watched: boolean;
    webUrl: string | null;
    health: RepoHealth;
    pipeline: PipelineView | null;
    stages: StageView[];
    lastCheckedAt: string | null;
    lastError: string | null;
    /** True while the sweep is on this repo — drives the row spinner. */
    checking: boolean;
}

export interface Settings {
    pollPeriodSeconds: number;
    retries: number;
    defaultRef: string;
    /** Tags currently narrowing the board. Empty means everything. */
    activeTags: string[];
    /** Poll only the repos carrying an active tag, rather than all of them. */
    scopeSweepToTags: boolean;
}

export interface TagView {
    name: string;
    count: number;
}

export interface SweepInfo {
    running: boolean;
    index: number;
    total: number;
    currentRepo: string | null;
    startedAt: string | null;
    finishedAt: string | null;
    lastDurationMs: number | null;
    nextRunAt: string | null;
}

/** Where an effective configuration value came from. */
export type ValueSource = 'inline' | 'file' | 'store' | 'missing';

export interface CredentialsInfo {
    complete: boolean;
    baseUrl: {
        value: string | null;
        source: ValueSource;
        /** True when the environment fixes it, so the UI must not offer an edit. */
        locked: boolean;
        error: string | null;
    };
    token: {
        present: boolean;
        source: ValueSource;
        masked: string | null;
        storage: string | null;
        locked: boolean;
        error: string | null;
    };
    /** Resolved username once GitLab accepted the pair. */
    username: string | null;
    /** Set when GitLab rejected the credentials; the setup panel stays open. */
    authError: string | null;
    /** Set when the instance could not be reached — not a credentials problem. */
    reachError: string | null;
    /** Where a newly saved token would be kept, and whether that is protected. */
    storageLabel: string;
    storageSecure: boolean;
}

export interface AppMeta {
    /**
     * Tags are stored and served, but the board only offers them when this is on.
     * The model is settled; the interface is not, so it ships dark until it is.
     */
    tagsEnabled: boolean;
    gitlabBaseUrl: string | null;
    user: string | null;
    /** SQLite file backing the watch list. */
    storePath: string;
    authError: string | null;
    credentials: CredentialsInfo;
    /** False while the board is unconfigured or blocked. */
    polling: boolean;
}

export interface AppState {
    repos: RepoView[];
    tags: TagView[];
    settings: Settings;
    sweep: SweepInfo;
    meta: AppMeta;
}

export type ServerEvent =
    | { type: 'meta'; meta: AppMeta }
    | { type: 'snapshot'; state: AppState }
    | { type: 'repo'; repo: RepoView }
    | { type: 'repos'; repos: RepoView[] }
    | { type: 'tags'; tags: TagView[] }
    | { type: 'sweep'; sweep: SweepInfo }
    | { type: 'settings'; settings: Settings }
    | { type: 'auth-error'; message: string };
