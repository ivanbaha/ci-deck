import { describe, expect, it } from 'bun:test';
import type { GitLabClient } from '../src/gitlab/client.ts';
import { GitLabRequestError } from '../src/gitlab/errors.ts';
import type { Poller } from '../src/core/poller.ts';
import type { Runtime } from '../src/core/runtime.ts';
import { AppStore, repoViewFromRecord } from '../src/core/state.ts';
import { DEFAULT_COLUMN_WIDTHS, type AppMeta, type Settings } from '../src/shared/types.ts';
import type { Assets } from '../src/server/assets.ts';
import { createServeOptions, MAX_IMPORT_REPOS } from '../src/server/app.ts';
import { allowedOrigins } from '../src/server/guard.ts';
import { WatchStore } from '../src/store/watch-store.ts';

const PORT = 8787;
const HOST_A = 'https://gitlab.corp.example/';
const HOST_B = 'https://gitlab.com/';

const SETTINGS: Settings = {
    pollPeriodSeconds: 120,
    retries: 5,
    defaultRef: 'main',
    confirmManualRun: true,
    notifications: 'on',
    theme: 'system',
    columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
};

function meta(): AppMeta {
    return {
        gitlabBaseUrl: HOST_A,
        user: 'me',
        storePath: ':memory:',
        authError: null,
        polling: true,
        credentials: {
            complete: true,
            baseUrl: { value: HOST_A, source: 'store', locked: false, error: null },
            token: { present: true, source: 'store', masked: 'glpat-…1234', storage: 'plaintext', locked: false, error: null },
            username: 'me',
            authError: null,
            reachError: null,
            storageLabel: 'plain text in the local database',
            storageSecure: false,
        },
    };
}

interface Options {
    /** Null stands for a board nobody has configured yet. */
    baseUrl?: string | null;
    polling?: boolean;
    client?: Partial<GitLabClient>;
    onTrigger?: () => void;
}

/**
 * The routes with a real store and app state behind them, and a stand-in for the
 * parts that would otherwise talk to GitLab. `Runtime` owns the credentials and
 * builds its own clients, so a fake is the only way to exercise a route without
 * a live instance.
 */
function harness(options: Options = {}) {
    const baseUrl = options.baseUrl === undefined ? HOST_A : options.baseUrl;
    const polling = options.polling ?? true;

    const watchStore = WatchStore.memory();
    const appStore = new AppStore({ ...SETTINGS }, meta());
    const triggers: number[] = [];

    const poller = {
        trigger: () => {
            options.onTrigger?.();
            triggers.push(Date.now());
        },
        invalidate: () => undefined,
        refreshRepo: async (id: number) => appStore.getRepo(id),
        get active() {
            return polling;
        },
    } as unknown as Poller;

    const runtime = {
        appStore,
        baseUrl,
        configured: baseUrl !== null,
        polling: baseUrl !== null && polling,
        client: (options.client ?? {}) as GitLabClient,
        activePoller: poller,
        refreshTags: () => appStore.setTags(baseUrl ? watchStore.listTags(baseUrl) : []),
        syncTags: (host: string) => appStore.setTags(watchStore.listTags(host)),
    } as unknown as Runtime;

    const assets: Assets = {
        index: () => Bun.file('/dev/null'),
        asset: async () => null,
    };

    const served = createServeOptions({
        runtime,
        watchStore,
        assets,
        origins: allowedOrigins(PORT),
    });

    /** Adds a row to both halves of the world, the way a real add does. */
    const seed = (name: string, projectId: number, ref = 'main', host = baseUrl ?? HOST_A) => {
        const record = watchStore.addRepo({ name, projectId, ref, path: `group/${name}`, baseUrl: host });
        if (host === baseUrl) appStore.addRepo(repoViewFromRecord(record, host));
        return record;
    };

    return { served, watchStore, appStore, triggers, seed };
}

type Params = Record<string, string>;

/** An absolute `path` stands for a request addressed to some other name. */
function request(path: string, init: RequestInit = {}, params?: Params) {
    const url = path.startsWith('http') ? path : `http://127.0.0.1:${PORT}${path}`;
    const made = new Request(url, init) as Request & { params?: Params };
    if (params) made.params = params;
    return made;
}

const jsonRequest = (path: string, method: string, body: unknown, params?: Params) =>
    request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, params);

const bodyOf = async <T>(response: Response): Promise<T> => (await response.json()) as T;

describe('GET /api/export', () => {
    /**
     * The one that matters: an export is meant to be shared, and a board that also
     * watches an internal instance must not leak its host and project paths into a
     * file exported from a public one.
     */
    it('carries only the instance the board is pointed at', async () => {
        const { served, seed } = harness({ baseUrl: HOST_B });
        seed('public-thing', 1, 'main', HOST_B);
        seed('internal-thing', 2, 'main', HOST_A);

        const response = await served.routes['/api/export'].GET(request('/api/export'));
        const text = await response.text();

        expect(response.status).toBe(200);
        expect(text).toContain('public-thing');
        expect(text).not.toContain('internal-thing');
        expect(text).not.toContain(HOST_A);
    });

    it('is a download, not something a page can be shown', async () => {
        const { served } = harness();

        const response = await served.routes['/api/export'].GET(request('/api/export'));

        expect(response.headers.get('Content-Disposition')).toContain('attachment');
        expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    });

    it('says the board is unconfigured rather than exporting nothing', async () => {
        const { served } = harness({ baseUrl: null });

        const response = await served.routes['/api/export'].GET(request('/api/export'));

        expect(response.status).toBe(409);
    });
});

describe('POST /api/import', () => {
    /**
     * A file decides what a row is called and where it links to. An absolute URL
     * in `path` used to be stored as-is and resolve to itself, putting an
     * attacker's link under a repo's own name on the board.
     */
    it('will not let a file point a row off the instance', async () => {
        const { served, appStore, watchStore } = harness();

        const response = await served.routes['/api/import'].POST(
            jsonRequest('/api/import', 'POST', {
                repos: [{ name: 'payments-api', projectId: 42, path: 'https://evil.example/payments-api' }],
            }),
        );

        expect(response.status).toBe(200);
        expect(await bodyOf<{ added: string[] }>(response)).toMatchObject({ added: ['payments-api · main'] });

        const record = watchStore.findRepo(HOST_A, 'payments-api', 'main')!;
        expect(record.path).toBe('payments-api');
        expect(appStore.getRepo(record.id)?.webUrl).toBe(`${HOST_A}payments-api`);
    });

    /**
     * A row is a repo and a branch, so the same repo twice on different branches
     * is two rows and not a duplicate. It used to be the primary key on its own.
     */
    it('takes the same repo once per branch', async () => {
        const { served, watchStore } = harness();

        const response = await served.routes['/api/import'].POST(
            jsonRequest('/api/import', 'POST', {
                repos: [
                    { name: 'alpha', projectId: 1, path: 'group/alpha', ref: 'main' },
                    { name: 'alpha', projectId: 1, path: 'group/alpha', ref: 'develop' },
                    { name: 'alpha', projectId: 1, path: 'group/alpha', ref: 'develop' },
                ],
            }),
        );

        const body = await bodyOf<{ added: string[]; skipped: { repo: string }[] }>(response);
        expect(body.added).toEqual(['alpha · main', 'alpha · develop']);
        expect(body.skipped).toHaveLength(1);
        expect(watchStore.listReposFor(HOST_A).map((repo) => repo.ref).sort()).toEqual(['develop', 'main']);
    });

    it('applies the settings the file carries', async () => {
        const { served, watchStore } = harness();

        const response = await served.routes['/api/import'].POST(
            jsonRequest('/api/import', 'POST', {
                settings: { pollPeriodSeconds: 300, defaultRef: 'develop' },
                repos: [{ name: 'alpha', projectId: 1, path: 'group/alpha' }],
            }),
        );

        const body = await bodyOf<{ settings: Settings }>(response);
        expect(body.settings.pollPeriodSeconds).toBe(300);
        expect(body.settings.defaultRef).toBe('develop');
        expect(watchStore.settings.defaultRef).toBe('develop');
    });

    it('leaves the settings alone when the file says nothing about them', async () => {
        const { served, watchStore } = harness();

        await served.routes['/api/import'].POST(
            jsonRequest('/api/import', 'POST', { repos: [{ name: 'alpha', projectId: 1, path: 'group/alpha' }] }),
        );

        expect(watchStore.settings.pollPeriodSeconds).toBe(SETTINGS.pollPeriodSeconds);
        expect(watchStore.settings.defaultRef).toBe(SETTINGS.defaultRef);
    });

    it('refuses a file far larger than any watch list', async () => {
        const { served } = harness();
        const repos = Array.from({ length: MAX_IMPORT_REPOS + 1 }, (_, index) => ({
            name: `repo-${index}`,
            projectId: index + 1,
            path: `group/repo-${index}`,
        }));

        const response = await served.routes['/api/import'].POST(jsonRequest('/api/import', 'POST', { repos }));

        expect(response.status).toBe(400);
        expect(await bodyOf<{ error: string }>(response)).toMatchObject({
            error: expect.stringContaining(String(MAX_IMPORT_REPOS)),
        });
    });

    it('rejects a body that is not JSON at all', async () => {
        const { served } = harness();

        const response = await served.routes['/api/import'].POST(
            request('/api/import', { method: 'POST', body: 'not json' }),
        );

        expect(response.status).toBe(400);
    });
});

describe('POST /api/sweep', () => {
    it('starts one when the board is polling', async () => {
        const { served, triggers } = harness();

        const response = await served.routes['/api/sweep'].POST(request('/api/sweep', { method: 'POST' }));

        expect(response.status).toBe(200);
        expect(triggers).toHaveLength(1);
    });

    /**
     * A token GitLab rejected stops the loop while the poller stays in place,
     * ignoring `trigger`. Claiming a sweep started is then simply untrue.
     */
    it('refuses instead of claiming one started, once polling has stopped', async () => {
        const { served, triggers } = harness({ polling: false });

        const response = await served.routes['/api/sweep'].POST(request('/api/sweep', { method: 'POST' }));

        expect(response.status).toBe(409);
        expect(await bodyOf<{ error: string }>(response)).toMatchObject({
            error: expect.stringContaining('Polling has stopped'),
        });
        expect(triggers).toHaveLength(0);
    });

    it('says so plainly when nothing is configured yet', async () => {
        const { served } = harness({ baseUrl: null });

        const response = await served.routes['/api/sweep'].POST(request('/api/sweep', { method: 'POST' }));

        expect(response.status).toBe(409);
        expect(await bodyOf<{ error: string }>(response)).toMatchObject({
            error: expect.stringContaining('not configured'),
        });
    });
});

describe('PUT /api/settings', () => {
    it('takes the branch new repos default to', async () => {
        const { served, watchStore } = harness();

        const response = await served.routes['/api/settings'].PUT(
            jsonRequest('/api/settings', 'PUT', { defaultRef: ' develop ' }),
        );

        expect(response.status).toBe(200);
        expect(watchStore.settings.defaultRef).toBe('develop');
    });

    it('refuses a branch name that is only whitespace', async () => {
        const { served } = harness();

        const response = await served.routes['/api/settings'].PUT(
            jsonRequest('/api/settings', 'PUT', { defaultRef: '   ' }),
        );

        expect(response.status).toBe(400);
    });

    it('refuses a request that changes nothing', async () => {
        const { served } = harness();

        const response = await served.routes['/api/settings'].PUT(jsonRequest('/api/settings', 'PUT', {}));

        expect(response.status).toBe(400);
    });

    it('takes the global notification mode, and only the three it has', async () => {
        const { served, watchStore } = harness();

        const ok = await served.routes['/api/settings'].PUT(
            jsonRequest('/api/settings', 'PUT', { notifications: 'snooze' }),
        );
        const bad = await served.routes['/api/settings'].PUT(
            jsonRequest('/api/settings', 'PUT', { notifications: 'sometimes' }),
        );

        expect(ok.status).toBe(200);
        expect(bad.status).toBe(400);
        expect(watchStore.settings.notifications).toBe('snooze');
    });

    it('takes a column width, clamped and merged over the rest', async () => {
        const { served, watchStore } = harness();

        const response = await served.routes['/api/settings'].PUT(
            jsonRequest('/api/settings', 'PUT', { columnWidths: { stages: 5_000 } }),
        );

        expect(response.status).toBe(200);
        expect(watchStore.settings.columnWidths.stages).toBe(900);
        expect(watchStore.settings.columnWidths.repo).toBe(DEFAULT_COLUMN_WIDTHS.repo);
    });

    it('takes the theme, and only the three it has', async () => {
        const { served, watchStore } = harness();

        const ok = await served.routes['/api/settings'].PUT(jsonRequest('/api/settings', 'PUT', { theme: 'light' }));
        const bad = await served.routes['/api/settings'].PUT(jsonRequest('/api/settings', 'PUT', { theme: 'sepia' }));

        expect(ok.status).toBe(200);
        expect(bad.status).toBe(400);
        expect(watchStore.settings.theme).toBe('light');
    });

    it('takes the manual-run confirmation switch', async () => {
        const { served, watchStore } = harness();

        const response = await served.routes['/api/settings'].PUT(
            jsonRequest('/api/settings', 'PUT', { confirmManualRun: false }),
        );

        expect(response.status).toBe(200);
        expect(watchStore.settings.confirmManualRun).toBe(false);
    });

    /**
     * A sweep is a round of requests against someone's GitLab. The interval earns
     * one because the poller works out the next wait when the last sweep ends, so
     * shortening it would otherwise sit out the rest of the old wait. Nothing else
     * here changes anything a pipeline could answer differently.
     */
    it('sweeps again when the interval changes', async () => {
        const { served, triggers } = harness();

        await served.routes['/api/settings'].PUT(
            jsonRequest('/api/settings', 'PUT', { pollPeriodSeconds: 30 }),
        );

        expect(triggers).toHaveLength(1);
    });

    it('does not sweep for a setting that only changes how the board looks', async () => {
        const { served, triggers } = harness();

        for (const patch of [
            { columnWidths: { stages: 420 } },
            { theme: 'light' },
            { notifications: 'snooze' },
            { confirmManualRun: false },
            { defaultRef: 'develop' },
        ]) {
            const response = await served.routes['/api/settings'].PUT(
                jsonRequest('/api/settings', 'PUT', patch),
            );
            expect(response.status).toBe(200);
        }

        expect(triggers).toHaveLength(0);
    });
});

describe('failures are attributed to whoever caused them', () => {
    it('blames GitLab only when GitLab is what failed', async () => {
        const { served } = harness({
            client: {
                getProject: () => Promise.reject(new GitLabRequestError(503, 'GitLab 503 on projects/x', 5)),
            },
        });

        const response = await served.routes['/api/repos'].POST(
            jsonRequest('/api/repos', 'POST', { repo: 'group/alpha' }),
        );

        expect(response.status).toBe(502);
    });

    it('owns a failure of its own rather than calling it a bad gateway', async () => {
        const { served } = harness({
            onTrigger: () => {
                throw new Error('the store fell over');
            },
        });

        const response = await served.routes['/api/sweep'].POST(request('/api/sweep', { method: 'POST' }));

        expect(response.status).toBe(500);
        expect(await bodyOf<{ error: string }>(response)).toMatchObject({ error: 'the store fell over' });
    });

    it('is a 404 for a repo that is not on the board', async () => {
        const { served } = harness();

        const response = await served.routes['/api/repos/:id/refresh'].POST(
            request('/api/repos/999/refresh', { method: 'POST' }, { id: '999' }),
        );

        expect(response.status).toBe(404);
    });

    it('is a 400 for a job id that is not one', async () => {
        const { served, seed } = harness();
        const alpha = seed('alpha', 1);

        const response = await served.routes['/api/repos/:id/jobs/:jobId/retry'].POST(
            request(`/api/repos/${alpha.id}/jobs/nope/retry`, { method: 'POST' }, { id: String(alpha.id), jobId: 'nope' }),
        );

        expect(response.status).toBe(400);
    });
});

describe('PUT /api/repos/:id/notify', () => {
    it('stores the mode and publishes it on the row', async () => {
        const { served, seed, appStore, watchStore } = harness();
        const alpha = seed('alpha', 1);

        const response = await served.routes['/api/repos/:id/notify'].PUT(
            jsonRequest(`/api/repos/${alpha.id}/notify`, 'PUT', { notify: 'snooze' }, { id: String(alpha.id) }),
        );

        expect(response.status).toBe(200);
        expect(watchStore.getRepo(alpha.id)?.notify).toBe('snooze');
        expect(appStore.getRepo(alpha.id)?.notify).toBe('snooze');
    });

    it('refuses a mode that is not one', async () => {
        const { served, seed } = harness();
        const alpha = seed('alpha', 1);

        const response = await served.routes['/api/repos/:id/notify'].PUT(
            jsonRequest(`/api/repos/${alpha.id}/notify`, 'PUT', { notify: 'loud' }, { id: String(alpha.id) }),
        );

        expect(response.status).toBe(400);
    });
});

describe('POST /api/repos/:id/stage/:action', () => {
    /** One control, one request — the browser used to fire one call per job. */
    it('retries every failed job in the stage, allowed to fail or not', async () => {
        const retried: number[] = [];
        const { served, seed, appStore } = harness({
            client: { retryJob: async (_project: number, jobId: number) => {
                retried.push(jobId);
                return {} as never;
            } },
        });
        const alpha = seed('alpha', 1);

        appStore.patchRepo(alpha.id, {
            stages: [{
                name: 'test',
                status: 'failed',
                hasManual: true,
                hasWarning: true,
                jobs: [
                    { id: 1, name: 'unit', stage: 'test', status: 'failed', allowFailure: false, durationSeconds: 1, webUrl: '', startedAt: null, finishedAt: null, retriedAttempts: 0 },
                    { id: 2, name: 'licenses', stage: 'test', status: 'failed', allowFailure: true, durationSeconds: 1, webUrl: '', startedAt: null, finishedAt: null, retriedAttempts: 0 },
                    { id: 3, name: 'deploy', stage: 'test', status: 'manual', allowFailure: false, durationSeconds: null, webUrl: '', startedAt: null, finishedAt: null, retriedAttempts: 0 },
                    { id: 4, name: 'lint', stage: 'test', status: 'success', allowFailure: false, durationSeconds: 1, webUrl: '', startedAt: null, finishedAt: null, retriedAttempts: 0 },
                ],
            }],
        });

        const response = await served.routes['/api/repos/:id/stage/:action'].POST(
            jsonRequest(`/api/repos/${alpha.id}/stage/retry`, 'POST', { stage: 'test' }, { id: String(alpha.id), action: 'retry' }),
        );

        expect(response.status).toBe(200);
        expect(retried.sort()).toEqual([1, 2]);
        expect(await bodyOf<{ acted: number; failed: number }>(response)).toMatchObject({ acted: 2, failed: 0 });
    });

    it('says so rather than pretending, when nothing in the stage applies', async () => {
        const { served, seed, appStore } = harness();
        const alpha = seed('alpha', 1);

        appStore.patchRepo(alpha.id, {
            stages: [{ name: 'test', status: 'success', hasManual: false, hasWarning: false, jobs: [] }],
        });

        const response = await served.routes['/api/repos/:id/stage/:action'].POST(
            jsonRequest(`/api/repos/${alpha.id}/stage/retry`, 'POST', { stage: 'test' }, { id: String(alpha.id), action: 'retry' }),
        );

        expect(response.status).toBe(409);
    });

    it('is a 404 for a stage the row does not have', async () => {
        const { served, seed } = harness();
        const alpha = seed('alpha', 1);

        const response = await served.routes['/api/repos/:id/stage/:action'].POST(
            jsonRequest(`/api/repos/${alpha.id}/stage/retry`, 'POST', { stage: 'ghost' }, { id: String(alpha.id), action: 'retry' }),
        );

        expect(response.status).toBe(404);
    });
});

describe('PUT /api/focus', () => {
    /**
     * An ordering, not a filter. Everything watched is still swept, or narrowing
     * the board would quietly decide which repos are allowed to notify you.
     */
    it('puts the rows on screen first and keeps the rest', async () => {
        const { served, seed, appStore } = harness();
        const alpha = seed('alpha', 1);
        const beta = seed('beta', 2);
        const gamma = seed('gamma', 3);

        const response = await served.routes['/api/focus'].PUT(
            jsonRequest('/api/focus', 'PUT', { repos: [gamma.id] }),
        );

        expect(response.status).toBe(200);
        expect(appStore.sweepOrder()).toEqual([gamma.id, alpha.id, beta.id]);
    });

    it('refuses anything that is not a list of ids', async () => {
        const { served } = harness();

        const response = await served.routes['/api/focus'].PUT(
            jsonRequest('/api/focus', 'PUT', { repos: 'alpha' }),
        );

        expect(response.status).toBe(400);
    });
});

describe('GET /api/resolve', () => {
    it('answers with the branches, and with what is already watched', async () => {
        const { served, seed } = harness({
            client: {
                getProject: async () => ({
                    id: 7,
                    name: 'alpha',
                    path_with_namespace: 'group/alpha',
                    web_url: `${HOST_A}group/alpha`,
                    default_branch: 'main',
                }),
                getBranches: async () => ['develop', 'main'],
            },
        });
        seed('alpha', 7, 'develop');

        const response = await served.routes['/api/resolve'].GET(request('/api/resolve?repo=group/alpha'));

        expect(response.status).toBe(200);
        const { candidate } = await bodyOf<{ candidate: { branches: string[]; watchedRefs: string[] } }>(response);
        // The default branch leads, because all but a handful of rows want it.
        expect(candidate.branches).toEqual(['main', 'develop']);
        expect(candidate.watchedRefs).toEqual(['develop']);
    });

    it('refuses an empty query rather than searching for nothing', async () => {
        const { served } = harness();

        const response = await served.routes['/api/resolve'].GET(request('/api/resolve?repo=%20'));

        expect(response.status).toBe(400);
    });
});

describe('the guard is wired into every route', () => {
    it('refuses a request addressed to a name this server does not answer to', async () => {
        const { served, seed, watchStore } = harness();
        const alpha = seed('alpha', 1);

        const response = await served.routes['/api/repos/:id'].DELETE(
            request(`http://evil.example:8787/api/repos/${alpha.id}`, { method: 'DELETE' }, { id: String(alpha.id) }),
        );

        expect(response.status).toBe(403);
        // Refused before the handler ran, not after it did the work.
        expect(watchStore.getRepo(alpha.id)).toBeDefined();
    });

    it('refuses a write carrying a foreign origin', async () => {
        const { served, triggers } = harness();

        const response = await served.routes['/api/sweep'].POST(
            request('/api/sweep', { method: 'POST', headers: { origin: 'http://evil.example' } }),
        );

        expect(response.status).toBe(403);
        expect(triggers).toHaveLength(0);
    });
});

describe('anything that is not an API path', () => {
    it('answers an unknown /api path with a 404 rather than the board', async () => {
        const { served } = harness();

        const response = await served.fetch(request('/api/nope'));

        expect(response.status).toBe(404);
        expect(response.headers.get('Content-Type')).toContain('application/json');
    });
});
