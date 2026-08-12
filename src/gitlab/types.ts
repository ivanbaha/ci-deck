/**
 * GitLab keeps adding statuses — `waiting_for_callback` is recent — so the union
 * stays open. The named members are what the board reasons about; anything else
 * still type-checks and degrades to the neutral kind instead of being a lie.
 */
export type GitLabStatus =
    | 'created'
    | 'waiting_for_resource'
    | 'waiting_for_callback'
    | 'preparing'
    | 'pending'
    | 'running'
    | 'success'
    | 'failed'
    | 'canceled'
    | 'canceling'
    | 'skipped'
    | 'manual'
    | 'scheduled'
    | (string & {});

export interface GitLabUser {
    id: number;
    username: string;
    name: string;
}

export interface GitLabCommitRef {
    id: string;
    short_id: string;
    title: string;
    author_name: string;
}

export interface GitLabPipeline {
    id: number;
    iid: number;
    project_id: number;
    sha: string;
    ref: string;
    status: GitLabStatus;
    source: string;
    web_url: string;
    created_at: string;
    updated_at: string;
}

export interface GitLabJob {
    id: number;
    name: string;
    stage: string;
    status: GitLabStatus;
    allow_failure: boolean;
    created_at: string;
    started_at: string | null;
    finished_at: string | null;
    duration: number | null;
    queued_duration: number | null;
    web_url: string;
    commit?: GitLabCommitRef;
    user?: GitLabUser | null;
}

export interface GitLabProject {
    id: number;
    name: string;
    path_with_namespace: string;
    web_url: string;
    default_branch: string | null;
}

export interface GitLabBranch {
    name: string;
    default: boolean;
}
