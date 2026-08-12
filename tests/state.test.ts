import { describe, expect, it } from 'bun:test';
import { AppStore, projectUrl, repoViewFromRecord } from '../src/core/state.ts';
import { DEFAULT_COLUMN_WIDTHS, type AppMeta } from '../src/shared/types.ts';
import type { RepoRecord } from '../src/store/watch-store.ts';

const HOST = 'https://gitlab.example.com/';

function meta(): AppMeta {
    return {
        gitlabBaseUrl: HOST,
        user: 'me',
        storePath: ':memory:',
        authError: null,
        polling: true,
        credentials: {
            complete: true,
            baseUrl: { value: HOST, source: 'store', locked: false, error: null },
            token: { present: true, source: 'store', masked: 'glpat-…1234', storage: 'plaintext', locked: false, error: null },
            username: 'me',
            authError: null,
            reachError: null,
            storageLabel: 'plain text in the local database',
            storageSecure: false,
        },
    };
}

/** A stored row, with only the parts a test cares about spelled out. */
function record(patch: Partial<RepoRecord> = {}): RepoRecord {
    return {
        id: 1,
        name: 'alpha',
        projectId: 1,
        path: 'group/alpha',
        ref: 'main',
        group: 'group',
        position: 1,
        baseUrl: HOST,
        watched: true,
        notify: 'on',
        branchMissing: false,
        ...patch,
    };
}

function newStore(): AppStore {
    return new AppStore(
        {
            pollPeriodSeconds: 120,
            retries: 5,
            defaultRef: 'main',
            confirmManualRun: true,
            notifications: 'on',
            theme: 'system',
            columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
        },
        meta(),
    );
}

function boardWithLiveData(tags: string[]) {
    const store = newStore();

    store.setRepos([repoViewFromRecord(record(), HOST, tags)]);

    // Whatever the last sweep learned from GitLab.
    store.patchRepo(1, {
        health: 'ok',
        pipeline: {
            id: 10, iid: 3, status: 'failed', ref: 'main', sha: 'abc', source: 'push',
            webUrl: `${HOST}group/alpha/-/pipelines/10`,
            createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
            commit: { shortId: 'abc1234', title: 'fix things', authorName: 'me' },
        },
        stages: [{ name: 'test', status: 'failed', hasManual: false, hasWarning: false, jobs: [] }],
        lastCheckedAt: '2026-01-01T00:02:00Z',
    });

    return store;
}

describe('AppStore.setRepoTags', () => {
    /**
     * Renaming or deleting a tag touches many rows at once. Rebuilding those rows
     * from the store was the obvious way to do it and the wrong one: the store
     * knows nothing about pipelines, so the whole board went blank until the next
     * sweep refilled it.
     */
    it('swaps tags without discarding what the sweep learned', () => {
        const store = boardWithLiveData(['backs', 'lib']);

        store.setRepoTags(new Map([[1, ['backend', 'lib']]]));

        const repo = store.getRepo(1)!;
        expect(repo.tags).toEqual(['backend', 'lib']);
        expect(repo.health).toBe('ok');
        expect(repo.pipeline?.status).toBe('failed');
        expect(repo.stages).toHaveLength(1);
        expect(repo.lastCheckedAt).toBe('2026-01-01T00:02:00Z');
    });

    it('clears the tags of a repo the map does not mention', () => {
        const store = boardWithLiveData(['backs']);

        store.setRepoTags(new Map());

        expect(store.getRepo(1)!.tags).toEqual([]);
        expect(store.getRepo(1)!.pipeline?.status).toBe('failed');
    });

    it('tells subscribers once, with the whole list', () => {
        const store = boardWithLiveData(['backs']);
        const seen: string[] = [];
        store.subscribe((event) => seen.push(event.type));

        store.setRepoTags(new Map([[1, ['x']]]));

        expect(seen).toEqual(['repos']);
    });
});

/**
 * Narrowing the board reorders the sweep and never shortens it. A filter that
 * also decided which repos still get checked would quietly decide which ones can
 * still tell you they broke, which is the opposite of watching them.
 */
describe('AppStore.sweepOrder', () => {
    const board = () => {
        const store = newStore();
        store.setRepos([
            repoViewFromRecord(record({ id: 1, name: 'alpha' }), HOST),
            repoViewFromRecord(record({ id: 2, name: 'beta' }), HOST),
            repoViewFromRecord(record({ id: 3, name: 'gamma' }), HOST),
        ]);
        return store;
    };

    it('is the board order while nothing is focused', () => {
        expect(board().sweepOrder()).toEqual([1, 2, 3]);
    });

    it('puts the focused rows first and keeps every other one', () => {
        const store = board();

        store.setFocus([3, 1]);

        expect(store.sweepOrder()).toEqual([3, 1, 2]);
    });

    it('ignores a row that has since been removed', () => {
        const store = board();

        store.setFocus([3, 99]);

        expect(store.sweepOrder()).toEqual([3, 1, 2]);
    });
});

/**
 * A watch list is a file people share, so the path in a row is not trusted to be
 * the relative `group/repo` it is supposed to be — it decides where the board's
 * own links point.
 */
describe('projectUrl', () => {
    it('resolves an ordinary project path against the instance', () => {
        expect(projectUrl('group/sub/alpha', HOST)).toBe(`${HOST}group/sub/alpha`);
    });

    it('keeps an instance served from a sub-path', () => {
        expect(projectUrl('group/alpha', 'https://host.example/gitlab/'))
            .toBe('https://host.example/gitlab/group/alpha');
    });

    it('refuses an absolute URL pointing somewhere else', () => {
        expect(projectUrl('https://evil.example/phish', HOST)).toBeNull();
    });

    it('refuses a scheme-relative URL, which resolves off-host in silence', () => {
        expect(projectUrl('//evil.example/phish', HOST)).toBeNull();
    });

    it('refuses a javascript: path', () => {
        expect(projectUrl('javascript:alert(1)', HOST)).toBeNull();
    });

    it('refuses a path that climbs out of an instance sub-path', () => {
        expect(projectUrl('../../elsewhere', 'https://host.example/gitlab/')).toBeNull();
    });

    it('has no link for a row that has no path', () => {
        expect(projectUrl(null, HOST)).toBeNull();
    });

    it('renders a rejected path as a row with no link rather than failing', () => {
        const view = repoViewFromRecord(
            record({ name: 'payments-api', projectId: 42, path: 'https://evil.example/payments-api' }),
            HOST,
        );

        expect(view.webUrl).toBeNull();
        expect(view.name).toBe('payments-api');
    });
});
