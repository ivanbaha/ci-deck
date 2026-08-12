import { describe, expect, it } from 'bun:test';
import { Poller, resolveNotifyMode } from '../src/core/poller.ts';
import { AppStore, repoViewFromRecord } from '../src/core/state.ts';
import { GitLabClient } from '../src/gitlab/client.ts';
import type { GitLabJob, GitLabPipeline } from '../src/gitlab/types.ts';
import {
    DEFAULT_COLUMN_WIDTHS,
    type AppMeta,
    type NotificationEvent,
    type NotifyMode,
    type ServerEvent,
    type Settings,
} from '../src/shared/types.ts';
import type { RepoRecord } from '../src/store/watch-store.ts';

const BASE_URL = 'https://gitlab.test/';

function testMeta(): AppMeta {
    return {
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

function testSettings(patch: Partial<Settings> = {}): Settings {
    return {
        pollPeriodSeconds: 120,
        retries: 1,
        defaultRef: 'main',
        confirmManualRun: true,
        notifications: 'on',
        theme: 'system',
        columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
        ...patch,
    };
}

function record(patch: Partial<RepoRecord> & Pick<RepoRecord, 'id' | 'name' | 'projectId'>): RepoRecord {
    return {
        path: `group/${patch.name}`,
        ref: 'main',
        group: 'group',
        position: patch.id,
        baseUrl: BASE_URL,
        watched: true,
        notify: 'on',
        branchMissing: false,
        ...patch,
    };
}

interface Scenario {
    projectId: number;
    pipeline?: Partial<GitLabPipeline> | null;
    jobs?: GitLabJob[];
    /** HTTP status to answer with instead of data. */
    failWith?: number;
    watched?: boolean;
    ref?: string;
    notify?: NotifyMode;
    /** Branches this project still has; anything else answers 404. */
    branches?: string[];
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

function setup(scenarios: Record<string, Scenario>, options: { retries?: number; settings?: Partial<Settings> } = {}) {
    const retries = options.retries ?? 1;
    const names = Object.keys(scenarios);
    const calls: string[] = [];
    const interactiveCalls: string[] = [];
    const missingBranches: { id: number; missing: boolean }[] = [];
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

        if (path.includes('/repository/branches/')) {
            const wanted = decodeURIComponent(path.split('/repository/branches/')[1]!);
            return (scenario.branches ?? ['main']).includes(wanted)
                ? new Response(JSON.stringify({ name: wanted, default: false }), { status: 200 })
                : new Response('{"message":"404 Branch Not Found"}', { status: 404 });
        }

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

    const store = new AppStore(testSettings({ retries, ...options.settings }), testMeta());

    const ids = new Map(names.map((name, index) => [name, index + 1]));

    store.setRepos(
        names.map((name) =>
            repoViewFromRecord(
                record({
                    id: ids.get(name)!,
                    name,
                    projectId: scenarios[name]!.projectId,
                    ref: scenarios[name]!.ref ?? 'main',
                    watched: scenarios[name]!.watched ?? true,
                    notify: scenarios[name]!.notify ?? 'on',
                }),
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
        flags: { setBranchMissing: (id, missing) => missingBranches.push({ id, missing }) },
    });

    const id = (name: string) => ids.get(name)!;
    const repo = (name: string) => store.getRepo(id(name))!;

    return {
        poller,
        store,
        calls,
        interactiveCalls,
        events,
        missingBranches,
        id,
        repo,
        maxInFlight: () => maxInFlight,
    };
}

const notifications = (events: ServerEvent[]): NotificationEvent[] =>
    events.filter((event) => event.type === 'notify').map((event) => event.notification);

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
        expect(harness.repo('repo-a').webUrl).toBe('https://gitlab.test/group/repo-a');
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
        const repo = harness.repo('repo-a');

        expect(repo.health).toBe('ok');
        expect(repo.pipeline?.status).toBe('failed');
        expect(repo.pipeline?.commit?.title).toBe('fix: thing');
        expect(repo.stages.map((stage) => `${stage.name}:${stage.status}`)).toEqual(['build:success', 'test:failed']);
        expect(repo.checking).toBe(false);
    });

    it('reports a ref without pipelines instead of an error', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, pipeline: null } });

        await harness.poller.sweepOnce();

        expect(harness.repo('repo-a').health).toBe('no-pipeline');
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
        expect(harness.repo('repo-paused').health).toBe('unknown');
    });

    it('still checks a paused repo when asked directly', async () => {
        const harness = setup({ 'repo-paused': { projectId: 2, watched: false } });

        await harness.poller.refreshRepo(harness.id('repo-paused'));

        expect(harness.repo('repo-paused').health).toBe('ok');
        expect(harness.interactiveCalls[0]).toBe('projects/2/pipelines');
    });

    it('sweeps an empty watch list without complaining', async () => {
        const harness = setup({});

        await harness.poller.sweepOnce();

        expect(harness.calls).toEqual([]);
        expect(harness.store.snapshot().sweep.total).toBe(0);
    });

    /**
     * The focus is an ordering the board sets from what it is showing. It must
     * never shorten the sweep: a repo filtered off screen is still a repo whose
     * pipeline you asked to be told about.
     */
    it('visits the focused rows first and still covers the rest', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 }, 'repo-b': { projectId: 2 }, 'repo-c': { projectId: 3 } });

        harness.store.setFocus([harness.id('repo-c')]);
        await harness.poller.sweepOnce();

        expect(harness.calls.filter((path) => path.endsWith('/pipelines'))).toEqual([
            'projects/3/pipelines',
            'projects/1/pipelines',
            'projects/2/pipelines',
        ]);
        expect(harness.store.snapshot().sweep.total).toBe(3);
    });
});

describe('Poller branch checks', () => {
    it('leaves the default branch alone, since it is not going anywhere', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 } });

        await harness.poller.sweepOnce();

        expect(harness.calls.some((path) => path.includes('/repository/branches/'))).toBe(false);
    });

    it('marks a row whose branch has been deleted, and records it', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, ref: 'feature/gone', branches: ['main'] } });

        await harness.poller.sweepOnce();

        expect(harness.calls[0]).toBe('projects/1/repository/branches/feature%2Fgone');
        expect(harness.repo('repo-a').branchMissing).toBe(true);
        expect(harness.missingBranches).toEqual([{ id: 1, missing: true }]);
    });

    it('clears the mark when the branch is back', async () => {
        const scenarios = { 'repo-a': { projectId: 1, ref: 'develop', branches: [] as string[] } };
        const harness = setup(scenarios);

        await harness.poller.sweepOnce();
        scenarios['repo-a'].branches = ['develop'];
        await harness.poller.refreshRepo(harness.id('repo-a'));

        expect(harness.repo('repo-a').branchMissing).toBe(false);
        expect(harness.missingBranches).toEqual([{ id: 1, missing: true }, { id: 1, missing: false }]);
    });

    /** One extra request per repo per pass, for an answer that changes once. */
    it('does not ask again inside the throttle window', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, ref: 'develop', branches: ['develop'] } });

        await harness.poller.sweepOnce();
        await harness.poller.sweepOnce();

        expect(harness.calls.filter((path) => path.includes('/repository/branches/'))).toHaveLength(1);
    });
});

describe('Poller notifications', () => {
    /** Only the transition. A pipeline already finished was never waited on. */
    it('announces a pipeline that was running and has stopped', async () => {
        const scenarios = { 'repo-a': { projectId: 1, pipeline: { status: 'running' } } as Scenario };
        const harness = setup(scenarios);

        await harness.poller.sweepOnce();
        expect(notifications(harness.events)).toHaveLength(0);

        scenarios['repo-a'].pipeline = { status: 'failed', updated_at: '2026-08-07T10:09:00Z' };
        scenarios['repo-a'].jobs = [job({ id: 2, name: 'unit', status: 'failed' })];
        await harness.poller.sweepOnce();

        expect(notifications(harness.events)).toEqual([{
            repoId: 1,
            repo: 'repo-a',
            ref: 'main',
            status: 'failed',
            pipelineIid: 12,
            webUrl: 'https://gitlab.test/group/repo/-/pipelines/500',
            silent: false,
            failedJobs: ['unit'],
        }]);
    });

    it('says nothing about a pipeline that was already finished when first seen', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 } });

        await harness.poller.sweepOnce();
        await harness.poller.sweepOnce();

        expect(notifications(harness.events)).toHaveLength(0);
    });

    it('says nothing when a new pipeline replaces the one being watched', async () => {
        const scenarios = { 'repo-a': { projectId: 1, pipeline: { status: 'running' } } as Scenario };
        const harness = setup(scenarios);

        await harness.poller.sweepOnce();
        scenarios['repo-a'].pipeline = { id: 501, status: 'success' };
        await harness.poller.sweepOnce();

        expect(notifications(harness.events)).toHaveLength(0);
    });

    it('still raises it, without a sound, for a snoozed row', async () => {
        const scenarios = {
            'repo-a': { projectId: 1, notify: 'snooze', pipeline: { status: 'running' } } as Scenario,
        };
        const harness = setup(scenarios);

        await harness.poller.sweepOnce();
        scenarios['repo-a'].pipeline = { status: 'success', updated_at: '2026-08-07T10:09:00Z' };
        await harness.poller.sweepOnce();

        expect(notifications(harness.events)).toMatchObject([{ silent: true, status: 'success' }]);
    });

    it('says nothing at all for a row switched off', async () => {
        const scenarios = {
            'repo-a': { projectId: 1, notify: 'off', pipeline: { status: 'running' } } as Scenario,
        };
        const harness = setup(scenarios);

        await harness.poller.sweepOnce();
        scenarios['repo-a'].pipeline = { status: 'success', updated_at: '2026-08-07T10:09:00Z' };
        await harness.poller.sweepOnce();

        expect(notifications(harness.events)).toHaveLength(0);
    });

    it('treats a pipeline that blocked on a manual job as a result', async () => {
        const scenarios = { 'repo-a': { projectId: 1, pipeline: { status: 'running' } } as Scenario };
        const harness = setup(scenarios);

        await harness.poller.sweepOnce();
        scenarios['repo-a'].pipeline = { status: 'manual', updated_at: '2026-08-07T10:09:00Z' };
        await harness.poller.sweepOnce();

        expect(notifications(harness.events)).toMatchObject([{ status: 'manual' }]);
    });
});

/** The global setting is a ceiling over each row's, not a default for it. */
describe('resolveNotifyMode', () => {
    it('lets a row be quieter than the board', () => {
        expect(resolveNotifyMode('on', 'snooze')).toBe('snooze');
        expect(resolveNotifyMode('on', 'off')).toBe('off');
    });

    it('will not let a row be louder than the board', () => {
        expect(resolveNotifyMode('snooze', 'on')).toBe('snooze');
        expect(resolveNotifyMode('off', 'on')).toBe('off');
    });

    it('is on only when both are', () => {
        expect(resolveNotifyMode('on', 'on')).toBe('on');
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
        await harness.poller.refreshRepo(harness.id('repo-a'));

        expect(harness.calls.filter((path) => path.endsWith('/jobs'))).toHaveLength(1);
        expect(harness.interactiveCalls).toEqual(['projects/1/pipelines', 'projects/1/pipelines/500/jobs']);
    });
});

describe('Poller failures', () => {
    it('marks a repo unreachable and carries on with the rest', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, failWith: 500 }, 'repo-b': { projectId: 2 } });

        await harness.poller.sweepOnce();

        const broken = harness.repo('repo-a');
        expect(broken.health).toBe('unreachable');
        expect(broken.lastError).toContain('after 2 attempts');
        expect(harness.repo('repo-b').health).toBe('ok');
    });

    it('stops the sweep and raises a banner when the token is rejected', async () => {
        const harness = setup({ 'repo-a': { projectId: 1, failWith: 401 }, 'repo-b': { projectId: 2 } });

        await harness.poller.sweepOnce();

        expect(harness.store.snapshot().meta.authError).toContain('401');
        expect(harness.repo('repo-b').health).toBe('unknown');
        expect(harness.events.some((event) => event.type === 'auth-error')).toBe(true);
        expect(harness.calls).toEqual(['projects/1/pipelines']);
    });
});

describe('AppStore reorder', () => {
    it('changes order without discarding pipeline data', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 }, 'repo-b': { projectId: 2 } });
        await harness.poller.sweepOnce();

        const before = harness.repo('repo-a');
        expect(before.pipeline).not.toBeNull();

        harness.store.reorder([harness.id('repo-b'), harness.id('repo-a')]);

        const after = harness.repo('repo-a');
        expect(after.pipeline).toEqual(before.pipeline);
        expect(after.stages).toEqual(before.stages);
        expect(after.health).toBe('ok');
        expect(harness.store.repoIds).toEqual([2, 1]);
    });

    it('keeps repos the caller forgot to mention', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 }, 'repo-b': { projectId: 2 } });

        harness.store.reorder([harness.id('repo-b')]);

        expect(harness.store.repoIds).toEqual([2, 1]);
    });

    it('ignores ids it does not know', async () => {
        const harness = setup({ 'repo-a': { projectId: 1 } });

        harness.store.reorder([99, harness.id('repo-a')]);

        expect(harness.store.repoIds).toEqual([1]);
    });
});
