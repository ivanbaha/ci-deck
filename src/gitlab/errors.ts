/** 401/403 from GitLab — the PAT is missing, expired or lacks scope. Never retried. */
export class GitLabAuthError extends Error {
    readonly status: number;

    constructor(status: number, detail: string) {
        super(`GitLab rejected the token (${status}): ${detail}`);
        this.name = 'GitLabAuthError';
        this.status = status;
    }
}

export class GitLabRequestError extends Error {
    readonly status: number;
    readonly attempts: number;

    constructor(status: number, message: string, attempts: number) {
        super(message);
        this.name = 'GitLabRequestError';
        this.status = status;
        this.attempts = attempts;
    }
}

export function isAuthError(error: unknown): error is GitLabAuthError {
    return error instanceof GitLabAuthError;
}

export function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
