import type { AppState, RepoView, Settings, TagView } from '../src/shared/types.ts';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(path, init);
    if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
    }
    return (await response.json()) as T;
}

function post<T>(path: string): Promise<T> {
    return request<T>(path, { method: 'POST' });
}

function json<T>(path: string, method: string, body: unknown): Promise<T> {
    return request<T>(path, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const repoPath = (name: string) => `/api/repos/${encodeURIComponent(name)}`;

export const api = {
    state: () => request<AppState>('/api/state'),

    setPollPeriod: (pollPeriodSeconds: number) =>
        json<{ settings: Settings }>('/api/settings', 'PUT', { pollPeriodSeconds }),

    setActiveTags: (activeTags: string[]) =>
        json<{ settings: Settings }>('/api/settings', 'PUT', { activeTags }),

    setSweepScope: (scopeSweepToTags: boolean) =>
        json<{ settings: Settings }>('/api/settings', 'PUT', { scopeSweepToTags }),

    createTag: (name: string) => json<{ tags: TagView[] }>('/api/tags', 'POST', { name }),

    renameTag: (from: string, name: string) =>
        json<{ tags: TagView[] }>(`/api/tags/${encodeURIComponent(from)}`, 'PUT', { name }),

    deleteTag: (name: string) =>
        request<{ tags: TagView[] }>(`/api/tags/${encodeURIComponent(name)}`, { method: 'DELETE' }),

    /** Bulk: one call sets a tag's whole membership. */
    setTagRepos: (name: string, repos: string[]) =>
        json<{ repos: string[]; tags: TagView[] }>(`/api/tags/${encodeURIComponent(name)}/repos`, 'PUT', { repos }),

    setRepoTags: (name: string, tags: string[]) =>
        json<{ tags: string[]; allTags: TagView[] }>(`${repoPath(name)}/tags`, 'PUT', { tags }),

    addRepo: (repo: string, ref?: string) =>
        json<{ repo: RepoView }>('/api/repos', 'POST', { repo, ref }),

    setCredentials: (body: { baseUrl?: string; token?: string }) =>
        json<{ username: string; storageLabel: string; storageSecure: boolean; warning?: string }>(
            '/api/credentials',
            'PUT',
            body,
        ),

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

    removeRepo: (name: string) => request<{ removed: string }>(repoPath(name), { method: 'DELETE' }),

    refreshRepo: (name: string) => post<{ repo: RepoView }>(`${repoPath(name)}/refresh`),

    sweep: () => post<{ started: boolean }>('/api/sweep'),

    retryPipeline: (name: string) => post<{ repo: RepoView }>(`${repoPath(name)}/pipeline/retry`),

    cancelPipeline: (name: string) => post<{ repo: RepoView }>(`${repoPath(name)}/pipeline/cancel`),

    retryJob: (name: string, jobId: number) => post<{ repo: RepoView }>(`${repoPath(name)}/jobs/${jobId}/retry`),

    cancelJob: (name: string, jobId: number) => post<{ repo: RepoView }>(`${repoPath(name)}/jobs/${jobId}/cancel`),

    playJob: (name: string, jobId: number) => post<{ repo: RepoView }>(`${repoPath(name)}/jobs/${jobId}/play`),

    setWatched: (name: string, watched: boolean) =>
        json<{ watched: boolean }>(`${repoPath(name)}/watch`, 'PUT', { watched }),

    async jobLog(name: string, jobId: number): Promise<string> {
        const response = await fetch(`${repoPath(name)}/jobs/${jobId}/log`);
        if (!response.ok) {
            const body = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
        }
        return await response.text();
    },
};
