import { GitLabAuthError, GitLabRequestError } from './errors.ts';
import type { GitLabBranch, GitLabJob, GitLabPipeline, GitLabProject, GitLabUser } from './types.ts';

export interface RetryPolicy {
    /** Extra attempts after the first one. */
    retries: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
    retries: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 16_000,
};

/** Narrower than `typeof fetch` so tests can inject a plain function. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RequestGate {
    run<T>(task: () => Promise<T>): Promise<T>;
}

export interface GitLabClientOptions {
    baseUrl: string;
    token: string;
    retry?: Partial<RetryPolicy>;
    /** Concurrency gate applied per attempt; omit for unrestricted calls. */
    lane?: RequestGate;
    fetchImpl?: FetchLike;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (info: { endpoint: string; attempt: number; delayMs: number; reason: string }) => void;
}

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class GitLabClient {
    readonly baseUrl: string;
    private readonly token: string;
    private readonly apiUrl: string;
    private readonly retry: RetryPolicy;
    private readonly lane: RequestGate | undefined;
    private readonly fetchImpl: FetchLike;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly onRetry: GitLabClientOptions['onRetry'];

    constructor(options: GitLabClientOptions) {
        this.baseUrl = options.baseUrl.endsWith('/') ? options.baseUrl : `${options.baseUrl}/`;
        this.token = options.token;
        this.apiUrl = `${this.baseUrl}api/v4/`;
        this.retry = { ...DEFAULT_RETRY_POLICY, ...options.retry };
        this.lane = options.lane;
        this.fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
        this.sleep = options.sleep ?? defaultSleep;
        this.onRetry = options.onRetry;
    }

    private backoffMs(attempt: number, retryAfterSeconds?: number): number {
        if (retryAfterSeconds !== undefined && Number.isFinite(retryAfterSeconds)) {
            return Math.min(Math.max(retryAfterSeconds, 0) * 1_000, this.retry.maxDelayMs);
        }
        return Math.min(this.retry.baseDelayMs * 2 ** (attempt - 1), this.retry.maxDelayMs);
    }

    /**
     * Single GitLab call with the shared retry policy. Auth failures and ordinary
     * 4xx short-circuit — retrying those only burns rate limit.
     */
    private async send(endpoint: string, init: RequestInit = {}): Promise<Response> {
        const url = `${this.apiUrl}${endpoint}`;
        const maxAttempts = this.retry.retries + 1;
        let lastReason = 'unknown';
        let lastStatus = 0;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            let response: Response | undefined;
            let retryAfter: number | undefined;

            const attemptFetch = () =>
                this.fetchImpl(url, {
                    ...init,
                    headers: {
                        Authorization: `Bearer ${this.token}`,
                        Accept: 'application/json',
                        ...(init.headers ?? {}),
                    },
                });

            try {
                // Gate each attempt, so a backing-off request frees its slot meanwhile.
                response = this.lane ? await this.lane.run(attemptFetch) : await attemptFetch();
            } catch (error) {
                lastReason = error instanceof Error ? error.message : String(error);
            }

            if (response) {
                if (response.ok) return response;

                lastStatus = response.status;
                const body = await response.text().catch(() => '');
                const detail = body.slice(0, 300);

                if (response.status === 401 || response.status === 403) {
                    throw new GitLabAuthError(response.status, detail || response.statusText);
                }

                if (!RETRYABLE_STATUSES.has(response.status)) {
                    throw new GitLabRequestError(
                        response.status,
                        `GitLab ${response.status} on ${endpoint}: ${detail || response.statusText}`,
                        attempt,
                    );
                }

                lastReason = `HTTP ${response.status}`;
                const header = response.headers.get('retry-after');
                if (header) retryAfter = Number.parseInt(header, 10);
            }

            if (attempt === maxAttempts) break;

            const delayMs = this.backoffMs(attempt, retryAfter);
            this.onRetry?.({ endpoint, attempt, delayMs, reason: lastReason });
            await this.sleep(delayMs);
        }

        throw new GitLabRequestError(
            lastStatus,
            `GitLab request failed after ${maxAttempts} attempts on ${endpoint}: ${lastReason}`,
            maxAttempts,
        );
    }

    async requestJson<T>(endpoint: string, init?: RequestInit): Promise<T> {
        const response = await this.send(endpoint, init);
        return (await response.json()) as T;
    }

    async requestText(endpoint: string, init?: RequestInit): Promise<string> {
        const response = await this.send(endpoint, init);
        return await response.text();
    }

    getCurrentUser(): Promise<GitLabUser> {
        return this.requestJson<GitLabUser>('user');
    }

    getProject(idOrPath: number | string): Promise<GitLabProject> {
        const key = typeof idOrPath === 'number' ? String(idOrPath) : encodeURIComponent(idOrPath);
        return this.requestJson<GitLabProject>(`projects/${key}`);
    }

    /**
     * Branch names, newest activity first, capped at one page. A project with
     * more branches than that has more than anyone picks from a list, and the
     * dialog says so rather than paging through hundreds of them.
     */
    async getBranches(projectId: number, perPage = 100): Promise<string[]> {
        const query = new URLSearchParams({ per_page: String(perPage) });
        const branches = await this.requestJson<GitLabBranch[]>(
            `projects/${projectId}/repository/branches?${query}`,
        );
        return branches.map((branch) => branch.name);
    }

    /**
     * Whether a branch is still there. A 404 is the answer, not a failure — every
     * other error is left to the caller, so an instance that is merely down is
     * never mistaken for a branch somebody deleted.
     */
    async branchExists(projectId: number, ref: string): Promise<boolean> {
        try {
            await this.requestJson<GitLabBranch>(
                `projects/${projectId}/repository/branches/${encodeURIComponent(ref)}`,
            );
            return true;
        } catch (error) {
            if (error instanceof GitLabRequestError && error.status === 404) return false;
            throw error;
        }
    }

    async getLatestPipeline(projectId: number, ref: string): Promise<GitLabPipeline | null> {
        const query = new URLSearchParams({ ref, per_page: '1', order_by: 'id', sort: 'desc' });
        const pipelines = await this.requestJson<GitLabPipeline[]>(
            `projects/${projectId}/pipelines?${query}`,
        );
        return pipelines[0] ?? null;
    }

    getPipelineJobs(projectId: number, pipelineId: number): Promise<GitLabJob[]> {
        return this.requestJson<GitLabJob[]>(
            `projects/${projectId}/pipelines/${pipelineId}/jobs?per_page=100&include_retried=true`,
        );
    }

    getJobLog(projectId: number, jobId: number): Promise<string> {
        return this.requestText(`projects/${projectId}/jobs/${jobId}/trace`);
    }

    retryJob(projectId: number, jobId: number): Promise<GitLabJob> {
        return this.requestJson<GitLabJob>(`projects/${projectId}/jobs/${jobId}/retry`, {
            method: 'POST',
        });
    }

    cancelJob(projectId: number, jobId: number): Promise<GitLabJob> {
        return this.requestJson<GitLabJob>(`projects/${projectId}/jobs/${jobId}/cancel`, {
            method: 'POST',
        });
    }

    /** Starts a manual job. These often deploy, so callers should confirm first. */
    playJob(projectId: number, jobId: number): Promise<GitLabJob> {
        return this.requestJson<GitLabJob>(`projects/${projectId}/jobs/${jobId}/play`, {
            method: 'POST',
        });
    }

    /** Reruns only the failed/canceled jobs of the pipeline, same as GitLab's "Retry". */
    retryPipeline(projectId: number, pipelineId: number): Promise<GitLabPipeline> {
        return this.requestJson<GitLabPipeline>(`projects/${projectId}/pipelines/${pipelineId}/retry`, {
            method: 'POST',
        });
    }

    cancelPipeline(projectId: number, pipelineId: number): Promise<GitLabPipeline> {
        return this.requestJson<GitLabPipeline>(`projects/${projectId}/pipelines/${pipelineId}/cancel`, {
            method: 'POST',
        });
    }
}
