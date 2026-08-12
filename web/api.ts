import type {
    AppState,
    ColumnKey,
    NotifyMode,
    RepoCandidate,
    RepoView,
    Settings,
    TagView,
    ThemePreference,
} from '../src/shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
}

function post<T>(path: string, body?: unknown): Promise<T> {
    return body === undefined
        ? request<T>(path, { method: 'POST' })
        : json<T>(path, 'POST', body);
}

function json<T>(path: string, method: string, body: unknown): Promise<T> {
    return request<T>(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const repoPath = (id: number) => `/api/repos/${id}`;

/**
 * What the tag form sends. Absent means "leave it"; `null` means "clear it",
 * which is how a description can be taken off a tag that had one.
 */
export type TagFields = {
    name?: string;
    description?: string | null;
    color?: string | null;
};

/** Every settings write goes through the one endpoint; this names the fields. */
type SettingsPatch = {
    pollPeriodSeconds?: number;
    defaultRef?: string;
    confirmManualRun?: boolean;
    notifications?: NotifyMode;
    theme?: ThemePreference;
    columnWidths?: Partial<Record<ColumnKey, number>>;
};

export const api = {
    state: () => request<AppState>('/api/state'),

    setSettings: (patch: SettingsPatch) => json<{ settings: Settings }>('/api/settings', 'PUT', patch),

    /** Which rows are on screen, so the sweep can reach them first. */
    setFocus: (repos: number[]) => json<{ focused: number }>('/api/focus', 'PUT', { repos }),

    /** Does this repo exist, and what can be watched on it. */
    resolveRepo: (repo: string) =>
        request<{ candidate: RepoCandidate }>(`/api/resolve?repo=${encodeURIComponent(repo)}`),

    createTag: (tag: TagFields) => json<{ tags: TagView[] }>('/api/tags', 'POST', tag),

    /** Only what is sent is written, so a partial patch leaves the rest alone. */
    updateTag: (from: string, changes: TagFields) =>
        json<{ tags: TagView[] }>(`/api/tags/${encodeURIComponent(from)}`, 'PUT', changes),

    deleteTag: (name: string) =>
        request<{ tags: TagView[] }>(`/api/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),

    /** Bulk: one call sets a tag's whole membership. */
    setTagRepos: (name: string, repos: number[]) =>
        json<{ repos: number[]; tags: TagView[] }>(`/api/tags/${encodeURIComponent(name)}/repos`, 'PUT', { repos }),

    setRepoTags: (id: number, tags: string[]) =>
        json<{ tags: string[]; allTags: TagView[] }>(`${repoPath(id)}/tags`, 'PUT', { tags }),

    addRepo: (repo: string, ref?: string) =>
        json<{ repo: RepoView }>('/api/repos', 'POST', { repo, ref }),

    setCredentials: (body: { baseUrl?: string; token?: string }) =>
        json<{ username: string; storageLabel: string; storageSecure: boolean; warning?: string }>(
            '/api/credentials',
            'PUT',
            body,
        ),

    /** Tries them against the instance and stores nothing either way. */
    testCredentials: (body: { baseUrl?: string; token?: string }) =>
        json<{ username: string; baseUrl: string }>('/api/credentials/test', 'POST', body),

    forgetCredentials: () => request<{ forgotten: boolean }>('/api/credentials', { method: 'DELETE' }),

    importList: (payload: unknown) =>
        json<{
            added: string[];
            /** Already watched, but the file's tags were merged onto them. */
            tagged: string[];
            skipped: { repo: string; reason: string }[];
            /** After applying whatever the file carried; also arrives over SSE. */
            settings: Settings;
        }>('/api/import', 'POST', payload),

    removeRepo: (id: number) => request<{ removed: number }>(repoPath(id), { method: 'DELETE' }),

    refreshRepo: (id: number) => post<{ repo: RepoView }>(`${repoPath(id)}/refresh`),

    sweep: () => post<{ started: boolean }>('/api/sweep'),

    retryPipeline: (id: number) => post<{ repo: RepoView }>(`${repoPath(id)}/pipeline/retry`),

    cancelPipeline: (id: number) => post<{ repo: RepoView }>(`${repoPath(id)}/pipeline/cancel`),

    retryJob: (id: number, jobId: number) => post<{ repo: RepoView }>(`${repoPath(id)}/jobs/${jobId}/retry`),

    cancelJob: (id: number, jobId: number) => post<{ repo: RepoView }>(`${repoPath(id)}/jobs/${jobId}/cancel`),

    playJob: (id: number, jobId: number) => post<{ repo: RepoView }>(`${repoPath(id)}/jobs/${jobId}/play`),

    /** One action over every job in a stage that it applies to. */
    actOnStage: (id: number, stage: string, action: 'retry' | 'cancel' | 'play') =>
        post<{ repo: RepoView; stage: string; acted: number; failed: number }>(
            `${repoPath(id)}/stage/${action}`,
            { stage },
        ),

    setWatched: (id: number, watched: boolean) =>
        json<{ watched: boolean }>(`${repoPath(id)}/watch`, 'PUT', { watched }),

    setNotify: (id: number, notify: NotifyMode) =>
        json<{ notify: NotifyMode }>(`${repoPath(id)}/notify`, 'PUT', { notify }),

    async jobLog(id: number, jobId: number): Promise<string> {
        const response = await fetch(`${repoPath(id)}/jobs/${jobId}/log`);
        if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
        }
        return await response.text();
    },
};
