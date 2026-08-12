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

/**
 * Whether a finished pipeline is announced. `snooze` still raises the
 * notification and only drops the sound — the quiet setting for a repo you want
 * to know about without being called away from what you are doing.
 */
export type NotifyMode = 'on' | 'snooze' | 'off';

export type ThemePreference = 'system' | 'dark' | 'light';

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
    /**
     * What the headline status had to leave out. A stage is one bubble, and the
     * worst thing in it is what that bubble has to say — but "worst" buries the
     * rest, and the two that matter are a job waiting to be started and a job
     * that failed while being allowed to. Both are carried alongside so the
     * bubble can mark them without giving up its headline.
     */
    hasManual: boolean;
    hasWarning: boolean;
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
    /**
     * The row's identity, and the only thing the API addresses it by. A repo can
     * be watched on several branches at once, so its name no longer picks out one
     * row — and a name is shared across instances besides.
     */
    id: number;
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
    notify: NotifyMode;
    /**
     * The branch this row watches is gone from GitLab. The row stays, struck
     * through, because a merged branch is the usual cause and the row is then
     * something to delete rather than something to fix.
     */
    branchMissing: boolean;
    webUrl: string | null;
    health: RepoHealth;
    pipeline: PipelineView | null;
    stages: StageView[];
    lastCheckedAt: string | null;
    lastError: string | null;
    /** True while the sweep is on this repo — drives the row spinner. */
    checking: boolean;
}

/**
 * Board columns whose width the user can set, in the order they appear.
 *
 * These share a fixed total — whatever the page leaves once the row controls have
 * taken their locked column — so a handle between two of them takes from one and
 * gives to the other, and the board itself never changes width. Stored values are
 * therefore weights rather than measurements: a narrower window redivides the
 * same proportions instead of overflowing.
 *
 * Actions is deliberately absent. It is the last column, it holds a fixed set of
 * buttons, and a width that fits them is the only width that is any use.
 */
export type ColumnKey = 'status' | 'repo' | 'pipeline' | 'commit' | 'stages' | 'time';

export const COLUMN_KEYS: ColumnKey[] = ['status', 'repo', 'pipeline', 'commit', 'stages', 'time'];

/**
 * The stage bubbles are why the board exists, so they get the room; the commit
 * message is the one thing that ellipsises gracefully, so it gives it up.
 */
export const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
    status: 104,
    repo: 248,
    // Wide enough for its own heading. The cell only ever holds `#1234`, but a
    // column narrower than the word above it now ellipsises that word.
    pipeline: 76,
    commit: 280,
    stages: 300,
    time: 128,
};

/** Narrow enough that a column cannot be dragged out of existence. */
export const MIN_COLUMN_WIDTH = 48;
export const MAX_COLUMN_WIDTH = 900;

export interface Settings {
    pollPeriodSeconds: number;
    retries: number;
    defaultRef: string;
    /** Manual jobs commonly deploy somewhere real, so starting one asks first. */
    confirmManualRun: boolean;
    /** Global switch over every row's own setting; `off` silences the board. */
    notifications: NotifyMode;
    theme: ThemePreference;
    columnWidths: Record<ColumnKey, number>;
}

export interface TagView {
    name: string;
    count: number;
    /** What the tag is for, when the name does not say it. */
    description: string | null;
    /** `#rrggbb`, or null for a tag that has never been given one. */
    color: string | null;
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

/** A pipeline that was in flight and has stopped being in flight. */
export interface NotificationEvent {
    repoId: number;
    repo: string;
    ref: string;
    status: GitLabStatus;
    pipelineIid: number;
    webUrl: string;
    /** Raised without the sound, because a setting somewhere says so. */
    silent: boolean;
    /** Names behind a red result, so the notification body can say what broke. */
    failedJobs: string[];
}

/** What a project lookup found, and what a branch can be picked from. */
export interface RepoCandidate {
    name: string;
    path: string;
    projectId: number;
    webUrl: string;
    defaultBranch: string | null;
    branches: string[];
    /** True when GitLab had more branches than one page could carry. */
    branchesTruncated: boolean;
    /** Branches of this project already on the board. */
    watchedRefs: string[];
}

export type ServerEvent =
    | { type: 'meta'; meta: AppMeta }
    | { type: 'snapshot'; state: AppState }
    | { type: 'repo'; repo: RepoView }
    | { type: 'repos'; repos: RepoView[] }
    | { type: 'tags'; tags: TagView[] }
    | { type: 'sweep'; sweep: SweepInfo }
    | { type: 'settings'; settings: Settings }
    | { type: 'notify'; notification: NotificationEvent }
    | { type: 'auth-error'; message: string };
