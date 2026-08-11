import { describe, expect, it } from 'bun:test';
import type { GitLabClient } from '../src/gitlab/client.ts';
import { GitLabRequestError } from '../src/gitlab/errors.ts';
import type { Poller } from '../src/core/poller.ts';
import type { Runtime } from '../src/core/runtime.ts';
import { AppStore, repoViewFromRecord } from '../src/core/state.ts';
import type { AppMeta, Settings } from '../src/shared/types.ts';
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
    activeTags: [],
    scopeSweepToTags: false,
};

function meta(): AppMeta {
    return {
        tagsEnabled: true,
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
        refreshRepo: async (name: string) => appStore.getRepo(name),
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

    /** Adds a repo to both halves of the world, the way a real add does. */
    const seed = (name: string, projectId: number, host = baseUrl ?? HOST_A) => {
        const record = watchStore.addRepo({ name, projectId, path: `group/${name}`, baseUrl: host });
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
        seed('public-thing', 1, HOST_B);
        seed('internal-thing', 2, HOST_A);

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
        expect(await bodyOf<{ added: string[] }>(response)).toMatchObject({ added: ['payments-api'] });
        expect(watchStore.getRepo('payments-api')?.path).toBe('payments-api');
        expect(appStore.getRepo('payments-api')?.webUrl).toBe(`${HOST_A}payments-api`);
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

        const response = await served.routes['/api/repos/:name/refresh'].POST(
            request('/api/repos/ghost/refresh', { method: 'POST' }, { name: 'ghost' }),
        );

        expect(response.status).toBe(404);
    });

    it('is a 400 for a job id that is not one', async () => {
        const { served, seed } = harness();
        seed('alpha', 1);

        const response = await served.routes['/api/repos/:name/jobs/:jobId/retry'].POST(
            request('/api/repos/alpha/jobs/nope/retry', { method: 'POST' }, { name: 'alpha', jobId: 'nope' }),
        );

        expect(response.status).toBe(400);
    });
});

describe('the guard is wired into every route', () => {
    it('refuses a request addressed to a name this server does not answer to', async () => {
        const { served, seed, watchStore } = harness();
        seed('alpha', 1);

        const response = await served.routes['/api/repos/:name'].DELETE(
            request('http://evil.example:8787/api/repos/alpha', { method: 'DELETE' }, { name: 'alpha' }),
        );

        expect(response.status).toBe(403);
        // Refused before the handler ran, not after it did the work.
        expect(watchStore.has('alpha')).toBe(true);
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
