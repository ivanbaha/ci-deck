import { describe, expect, it } from 'bun:test';
import { AppStore, repoViewFromRecord } from '../src/core/state.ts';
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
                webUrl: `${HOST}group/alpha`,
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
