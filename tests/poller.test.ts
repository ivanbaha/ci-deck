import { describe, expect, it } from 'bun:test';
import { Poller } from '../src/core/poller.ts';
import { AppStore, repoViewFromRecord } from '../src/core/state.ts';
import { GitLabClient } from '../src/gitlab/client.ts';
import type { GitLabJob, GitLabPipeline } from '../src/gitlab/types.ts';
import type { AppMeta, ServerEvent } from '../src/shared/types.ts';

const BASE_URL = 'https://gitlab.test/';

function testMeta(): AppMeta {
    return {
        tagsEnabled: false,
        gitlabBaseUrl: BASE_URL,
        user: 'zbahiva',
        storePath: ':memory:',
        authError: null,
        polling: true,
        credentials: {
            complete: true,
            baseUrl: { value: BASE_URL, source: 'store', locked: false, error: null },
            token: {
                present: true,
                source: 'store',
                masked: 'glpat-…test',
                storage: 'plaintext',
                locked: false,
                error: null,
            },
            username: 'zbahiva',
            authError: null,
            reachError: null,
            storageLabel: 'plain text in the local database',
            storageSecure: false,
        },
    };
}

interface Scenario {
    projectId: number;
    pipeline?: Partial<GitLabPipeline> | null;
    jobs?: GitLabJob[];
    /** HTTP status to answer with instead of data. */
    failWith?: number;
    watched?: boolean;
}

function pipeline(overrides: Partial<GitLabPipeline> = {}): GitLabPipeline {
    return {
        id: 500,
        iid: 12,
        project_id: 1,
        sha: 'abcdef0123456789',
        ref: 'main',
        status: 'success',
        source: 'push',
        web_url: 'https://gitlab.test/group/repo/-/pipelines/500',
        created_at: '2026-08-07T10:00:00Z',
        updated_at: '2026-08-07T10:05:00Z',
        ...overrides,
    };
}

function job(overrides: Partial<GitLabJob> = {}): GitLabJob {
    return {
        id: 900,
        name: 'unit',
        stage: 'test',
        status: 'success',
        allow_failure: false,
        created_at: '2026-08-07T10:00:00Z',
        started_at: '2026-08-07T10:00:10Z',
        finished_at: '2026-08-07T10:01:00Z',
        duration: 50,
        queued_duration: 1,
        web_url: 'https://gitlab.test/group/repo/-/jobs/900',
        ...overrides,
    };
}

function setup(scenarios: Record<string, Scenario>, retries = 1) {
    const names = Object.keys(scenarios);
    const calls: string[] = [];
    const interactiveCalls: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;

    const respond = (log: string[]) => async (input: string) => {
        const path = new URL(input).pathname.replace('/api/v4/', '');
        log.push(path);

        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight -= 1;

        const projectId = Number(path.split('/')[1]);
        const scenario = Object.values(scenarios).find((entry) => entry.projectId === projectId)!;

        if (scenario.failWith) return new Response('nope', { status: scenario.failWith });
        if (path.endsWith('/jobs')) {
            return new Response(JSON.stringify(scenario.jobs ?? [job()]), { status: 200 });
        }
        const value = scenario.pipeline === null ? [] : [pipeline({ project_id: projectId, ...scenario.pipeline })];
        return new Response(JSON.stringify(value), { status: 200 });
    };

    const clientOptions = {
        baseUrl: BASE_URL,
        token: 'glpat-test',
        retry: { retries, baseDelayMs: 1, maxDelayMs: 1 },
        sleep: async () => undefined,
    };

    const client = new GitLabClient({ ...clientOptions, fetchImpl: respond(calls) });
    const interactiveClient = new GitLabClient({ ...clientOptions, fetchImpl: respond(interactiveCalls) });

    const store = new AppStore(
        { pollPeriodSeconds: 120, retries, defaultRef: 'main', activeTags: [], scopeSweepToTags: false },
        testMeta(),
    );

    store.setRepos(
        names.map((name, index) =>
            repoViewFromRecord(
                {
                    name,
                    projectId: scenarios[name]!.projectId,
                    path: `group/${name}`,
                    ref: 'main',
                    group: 'group',
                    position: index + 1,
                    baseUrl: BASE_URL,
                    webUrl: `${BASE_URL}group/${name}`,
                    watched: scenarios[name]!.watched ?? true,
                },
                BASE_URL,
            ),
        ),
    );

    const events: ServerEvent[] = [];
    store.subscribe((event) => events.push(event));

    const poller = new Poller({
        client,
        interactiveClient,
        store,
        spacingMs: 0,
        sleep: async () => undefined,
        now: () => Date.parse('2026-08-07T10:06:00Z'),
    });

    return { poller, store, calls, interactiveCalls, events, maxInFlight: () => maxInFlight };
}

describe('Poller sweep', () => {
    it('checks repos one after another, never in parallel', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 }, 'repo-b': { projectId: 2 }, 'repo-c': { projectId: 3 } });

        await harness.poller.sweepOnce();

        expect(harness.maxInFlight()).toBe(1);
        expect(harness.calls).toEqual([
            'projects/1/pipelines',
            'projects/1/pipelines/500/jobs',
            'projects/2/pipelines',
            'projects/2/pipelines/500/jobs',
            'projects/3/pipelines',
            'projects/3/pipelines/500/jobs',
        ]);
    });

    it('uses the project id from the watch list without resolving it again', async () => {
        const harness = setup({ 'repo-a': { projectId: 77 } });

        await harness.poller.sweepOnce();

        expect(harness.calls.some((path) => path.startsWith('projects?search'))).toBe(false);
        expect(harness.calls[0]).toBe('projects/77/pipelines');
    });

    it('links the row to GitLab from the stored path before the first check', () => {
        const harness = setup({ 'repo-a': { projectId: 1 } });
        expect(harness.store.getRepo('repo-a')!.webUrl).toBe('https://gitlab.test/group/repo-a');
    });

    it('fills the row from the pipeline and its jobs', async () => {
        const harness = setup({
            'repo-a': {
                projectId: 1,
                pipeline: { status: 'failed' },
                jobs: [
                    job({ id: 1, stage: 'build', name: 'compile', status: 'success' }),
                    job({
                        id: 2,
                        stage: 'test',
                        name: 'unit',
                        status: 'failed',
                        commit: { id: 'abc', short_id: 'abc1234', title: 'fix: thing', author_name: 'Ivan' },
                    }),
                ],
            },
        });

        await harness.poller.sweepOnce();
        const repo = harness.store.getRepo('repo-a')!;

        expect(repo.health).toBe('ok');
        expect(repo.pipeline?.status).toBe('failed');
        expect(repo.pipeline?.commit?.title).toBe('fix: thing');
        expect(repo.stages.map((stage) => `${stage.name}:${stage.status}`)).toEqual(['build:success', 'test:failed']);
        expect(repo.checking).toBe(false);
    });

    it('reports a ref without pipelines instead of an error', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, pipeline: null } });

        await harness.poller.sweepOnce();

        expect(harness.store.getRepo('repo-a')!.health).toBe('no-pipeline');
        expect(harness.calls).toEqual(['projects/1/pipelines']);
    });

    it('tracks sweep progress and duration', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 }, 'repo-b': { projectId: 2 } });

        await harness.poller.sweepOnce();
        const sweep = harness.store.snapshot().sweep;

        expect(sweep.running).toBe(false);
        expect(sweep.total).toBe(2);
        expect(sweep.index).toBe(2);
        expect(sweep.lastDurationMs).toBe(0);
        expect(sweep.finishedAt).toBe('2026-08-07T10:06:00.000Z');
    });

    it('skips paused repos and leaves them out of the progress count', async () => {
        const harness = setup({
            'repo-a': { projectId: 1 },
            'repo-paused': { projectId: 2, watched: false },
            'repo-c': { projectId: 3 },
        });

        await harness.poller.sweepOnce();

        expect(harness.calls.some((path) => path.startsWith('projects/2'))).toBe(false);
        expect(harness.store.snapshot().sweep.total).toBe(2);
        expect(harness.store.getRepo('repo-paused')!.health).toBe('unknown');
    });

    it('still checks a paused repo when asked directly', async () => {
        const harness = setup({ 'repo-paused': { projectId: 2, watched: false } });

        await harness.poller.refreshRepo('repo-paused');

        expect(harness.store.getRepo('repo-paused')!.health).toBe('ok');
        expect(harness.interactiveCalls[0]).toBe('projects/2/pipelines');
    });

    it('sweeps an empty watch list without complaining', async () => {
        const harness = setup({});

        await harness.poller.sweepOnce();

        expect(harness.calls).toEqual([]);
        expect(harness.store.snapshot().sweep.total).toBe(0);
    });
});

describe('Poller jobs cache', () => {
    it('skips the jobs call while a finished pipeline is unchanged', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 } });

        await harness.poller.sweepOnce();
        await harness.poller.sweepOnce();

        expect(harness.calls.filter((path) => path.endsWith('/jobs'))).toHaveLength(1);
        expect(harness.calls.filter((path) => path.endsWith('/pipelines'))).toHaveLength(2);
    });

    it('refetches jobs when the pipeline was updated', async () => {
        const scenarios = { 'repo-a': { projectId: 1 } as Scenario };
        const harness = setup(scenarios);

        await harness.poller.sweepOnce();
        scenarios['repo-a'].pipeline = { updated_at: '2026-08-07T10:09:00Z', status: 'success' };
        await harness.poller.sweepOnce();

        expect(harness.calls.filter((path) => path.endsWith('/jobs'))).toHaveLength(2);
    });

    it('refetches jobs of an unfinished pipeline even when updated_at is unchanged', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, pipeline: { status: 'running' } } });

        await harness.poller.sweepOnce();
        await harness.poller.sweepOnce();
        await harness.poller.sweepOnce();

        expect(harness.calls.filter((path) => path.endsWith('/jobs'))).toHaveLength(3);
    });

    it('keeps refetching a pipeline stuck in a waiting state', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, pipeline: { status: 'manual' } } });

        await harness.poller.sweepOnce();
        await harness.poller.sweepOnce();

        expect(harness.calls.filter((path) => path.endsWith('/jobs'))).toHaveLength(2);
    });

    it('bypasses the cache on an explicit refresh, using the interactive lane', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 } });

        await harness.poller.sweepOnce();
        await harness.poller.refreshRepo('repo-a');

        expect(harness.calls.filter((path) => path.endsWith('/jobs'))).toHaveLength(1);
        expect(harness.interactiveCalls).toEqual(['projects/1/pipelines', 'projects/1/pipelines/500/jobs']);
    });
});

describe('Poller failures', () => {
    it('marks a repo unreachable and carries on with the rest', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, failWith: 500 }, 'repo-b': { projectId: 2 } });

        await harness.poller.sweepOnce();

        const broken = harness.store.getRepo('repo-a')!;
        expect(broken.health).toBe('unreachable');
        expect(broken.lastError).toContain('after 2 attempts');
        expect(harness.store.getRepo('repo-b')!.health).toBe('ok');
    });

    it('stops the sweep and raises a banner when the token is rejected', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, failWith: 401 }, 'repo-b': { projectId: 2 } });

        await harness.poller.sweepOnce();

        expect(harness.store.snapshot().meta.authError).toContain('401');
        expect(harness.store.getRepo('repo-b')!.health).toBe('unknown');
        expect(harness.events.some((event) => event.type === 'auth-error')).toBe(true);
        expect(harness.calls).toEqual(['projects/1/pipelines']);
    });
});

describe('AppStore reorder', () => {
    it('changes order without discarding pipeline data', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 }, 'repo-b': { projectId: 2 } });
        await harness.poller.sweepOnce();

        const before = harness.store.getRepo('repo-a')!;
        expect(before.pipeline).not.toBeNull();

        harness.store.reorder(['repo-b', 'repo-a']);

        const after = harness.store.getRepo('repo-a')!;
        expect(after.pipeline).toEqual(before.pipeline);
        expect(after.stages).toEqual(before.stages);
        expect(after.health).toBe('ok');
        expect(harness.store.repoNames).toEqual(['repo-b', 'repo-a']);
    });

    it('keeps repos the caller forgot to mention', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 }, 'repo-b': { projectId: 2 } });

        harness.store.reorder(['repo-b']);

        expect(harness.store.repoNames).toEqual(['repo-b', 'repo-a']);
    });

    it('ignores names it does not know', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 } });

        harness.store.reorder(['ghost', 'repo-a']);

        expect(harness.store.repoNames).toEqual(['repo-a']);
    });
});

describe('sweep scoping by tag', () => {
    /** A board where each repo carries the tags its name implies. */
    function taggedStore(tagsByRepo: Record<string, string[]>) {
        const store = new AppStore(
            { pollPeriodSeconds: 120, retries: 1, defaultRef: 'main', activeTags: [], scopeSweepToTags: false },
            testMeta(),
        );

        store.setRepos(
            Object.entries(tagsByRepo).map(([name, tags], index) =>
                repoViewFromRecord(
                    {
                        name,
                        projectId: index + 1,
                        path: `group/${name}`,
                        ref: 'main',
                        group: 'group',
                        position: index + 1,
                        baseUrl: 'https://gitlab.example.com/',
                        webUrl: null,
                        watched: true,
                    },
                    'https://gitlab.example.com/',
                    tags,
                ),
            ),
        );

        return store;
    }

    it('narrows the board to the repos carrying an active tag', () => {
        const store = taggedStore({ alpha: ['lib'], beta: ['lib', 'backs'], gamma: ['front'] });

        expect(store.reposWithAnyTag(['lib'])).toEqual(['alpha', 'beta']);
        expect(store.reposWithAnyTag(['front'])).toEqual(['gamma']);
    });

    it('unions rather than intersects when several tags are active', () => {
        const store = taggedStore({ alpha: ['lib'], beta: ['backs'], gamma: ['front'] });

        expect(store.reposWithAnyTag(['lib', 'front'])).toEqual(['alpha', 'gamma']);
    });

    it('treats no active tags as no restriction', () => {
        const store = taggedStore({ alpha: ['lib'], beta: [] });

        expect(store.reposWithAnyTag([])).toEqual(['alpha', 'beta']);
    });

    /**
     * The point of the feature: watch two hundred repos, poll the handful the
     * filter is on. Without it a serial sweep at that size never finishes in time.
     */
    it('polls only the scoped repos when the sweep is scoped', async () => {
        const store = taggedStore({ alpha: ['lib'], beta: ['lib'], gamma: ['front'] });
        store.setSettings({ activeTags: ['lib'], scopeSweepToTags: true });

        const checked: string[] = [];
        const client = new GitLabClient({
            baseUrl: 'https://gitlab.example.com/',
            token: 'glpat-test',
            retry: { retries: 0 },
            sleep: async () => undefined,
            fetchImpl: async (url) => {
                const match = /projects\/(\d+)\/pipelines/.exec(url);
                if (match) checked.push(match[1]!);
                return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
        });

        const poller = new Poller({ client, store, spacingMs: 0, sleep: async () => undefined });
        await poller.sweepOnce();

        expect(checked).toEqual(['1', '2']);
        expect(store.snapshot().sweep.total).toBe(2);
    });

    it('polls everything when scoping is off, however the board is filtered', async () => {
        const store = taggedStore({ alpha: ['lib'], beta: ['front'] });
        store.setSettings({ activeTags: ['lib'], scopeSweepToTags: false });

        const checked: string[] = [];
        const client = new GitLabClient({
            baseUrl: 'https://gitlab.example.com/',
            token: 'glpat-test',
            retry: { retries: 0 },
            sleep: async () => undefined,
            fetchImpl: async (url) => {
                const match = /projects\/(\d+)\/pipelines/.exec(url);
                if (match) checked.push(match[1]!);
                return new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } });
            },
        });

        await new Poller({ client, store, spacingMs: 0, sleep: async () => undefined }).sweepOnce();

        expect(checked).toEqual(['1', '2']);
    });
});
