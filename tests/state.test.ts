import { describe, expect, it } from 'bun:test';
import { AppStore, projectUrl, repoViewFromRecord } from '../src/core/state.ts';
import type { AppMeta } from '../src/shared/types.ts';

const HOST = 'https://gitlab.example.com/';

function meta(): AppMeta {
    return {
        tagsEnabled: false,
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

function boardWithLiveData(tags: string[]) {
    const store = new AppStore(
        { pollPeriodSeconds: 120, retries: 5, defaultRef: 'main', activeTags: [], scopeSweepToTags: false },
        meta(),
    );

    store.setRepos([
        repoViewFromRecord(
            {
                name: 'alpha',
                projectId: 1,
                path: 'group/alpha',
                ref: 'main',
                group: 'group',
                position: 1,
                baseUrl: HOST,
                watched: true,
            },
            HOST,
            tags,
        ),
    ]);

    // Whatever the last sweep learned from GitLab.
    store.patchRepo('alpha', {
        health: 'ok',
        pipeline: {
            id: 10, iid: 3, status: 'failed', ref: 'main', sha: 'abc', source: 'push',
            webUrl: `${HOST}group/alpha/-/pipelines/10`,
            createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:01:00Z',
            commit: { shortId: 'abc1234', title: 'fix things', authorName: 'me' },
        },
        stages: [{ name: 'test', status: 'failed', jobs: [] }],
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

        store.setRepoTags(new Map([['alpha', ['backend', 'lib']]]));

        const repo = store.getRepo('alpha')!;
        expect(repo.tags).toEqual(['backend', 'lib']);
        expect(repo.health).toBe('ok');
        expect(repo.pipeline?.status).toBe('failed');
        expect(repo.stages).toHaveLength(1);
        expect(repo.lastCheckedAt).toBe('2026-01-01T00:02:00Z');
    });

    it('clears the tags of a repo the map does not mention', () => {
        const store = boardWithLiveData(['backs']);

        store.setRepoTags(new Map());

        expect(store.getRepo('alpha')!.tags).toEqual([]);
        expect(store.getRepo('alpha')!.pipeline?.status).toBe('failed');
    });

    it('tells subscribers once, with the whole list', () => {
        const store = boardWithLiveData(['backs']);
        const seen: string[] = [];
        store.subscribe((event) => seen.push(event.type));

        store.setRepoTags(new Map([['alpha', ['x']]]));

        expect(seen).toEqual(['repos']);
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
            {
                name: 'payments-api',
                projectId: 42,
                path: 'https://evil.example/payments-api',
                ref: 'main',
                group: 'group',
                position: 1,
                baseUrl: HOST,
                watched: true,
            },
            HOST,
        );

        expect(view.webUrl).toBeNull();
        expect(view.name).toBe('payments-api');
    });
});
