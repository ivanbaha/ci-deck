import { describe, expect, it } from 'bun:test';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    DEFAULT_SETTINGS,
    MAX_POLL_SECONDS,
    MIN_POLL_SECONDS,
    parseExportFile,
    WatchStore,
} from '../src/store/watch-store.ts';

const HOST = 'https://gitlab.example.com/';

const repo = (name: string, projectId: number) => ({
    name,
    projectId,
    path: `group/${name}`,
    group: 'group',
    baseUrl: HOST,
    webUrl: `${HOST}group/${name}`,
});

describe('WatchStore defaults', () => {
    it('starts with an empty watch list', () => {
        const store = WatchStore.memory();
        expect(store.listRepos()).toEqual([]);
        expect(store.count).toBe(0);
    });

    it('reports the built-in settings before anything is stored', () => {
        expect(WatchStore.memory().settings).toEqual(DEFAULT_SETTINGS);
    });

    it('clamps the poll period into the allowed window', () => {
        const store = WatchStore.memory();

        expect(store.setPollPeriod(1)).toBe(MIN_POLL_SECONDS);
        expect(store.setPollPeriod(99_999)).toBe(MAX_POLL_SECONDS);
        expect(store.setPollPeriod(300)).toBe(300);
        expect(store.settings.pollPeriodSeconds).toBe(300);
    });

    it('keeps a stored default ref', () => {
        const store = WatchStore.memory();
        store.setDefaultRef(' develop ');
        expect(store.settings.defaultRef).toBe('develop');
    });
});

describe('WatchStore repos', () => {
    it('adds a repo and reads it back', () => {
        const store = WatchStore.memory();
        const record = store.addRepo(repo('alpha', 1));

        expect(record).toEqual({
            name: 'alpha',
            projectId: 1,
            path: 'group/alpha',
            ref: DEFAULT_SETTINGS.defaultRef,
            group: 'group',
            position: 1,
            baseUrl: HOST,
            webUrl: `${HOST}group/alpha`,
            watched: true,
        });
        expect(store.has('alpha')).toBe(true);
    });

    it('applies the stored default ref to new repos', () => {
        const store = WatchStore.memory();
        store.setDefaultRef('trunk');

        expect(store.addRepo(repo('alpha', 1)).ref).toBe('trunk');
        expect(store.addRepo({ ...repo('beta', 2), ref: 'release' }).ref).toBe('release');
    });

    it('keeps insertion order', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('zulu', 1));
        store.addRepo(repo('alpha', 2));
        store.addRepo(repo('mike', 3));

        expect(store.listRepos().map((entry) => entry.name)).toEqual(['zulu', 'alpha', 'mike']);
    });

    it('refuses to add the same repo twice', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));

        expect(() => store.addRepo(repo('alpha', 1))).toThrow(/already on the watch list/);
    });

    it('removes a repo and reports when there was nothing to remove', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));

        expect(store.removeRepo('alpha')).toBe(true);
        expect(store.removeRepo('alpha')).toBe(false);
        expect(store.count).toBe(0);
    });

    it('keeps the surviving order and appends after a removal', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));
        store.addRepo(repo('beta', 2));
        store.addRepo(repo('gamma', 3));
        store.removeRepo('beta');
        store.addRepo(repo('delta', 4));

        expect(store.listRepos().map((entry) => entry.name)).toEqual(['alpha', 'gamma', 'delta']);
    });

    it('defaults the group when none is given', () => {
        const store = WatchStore.memory();
        expect(store.addRepo({ name: 'alpha', projectId: 1 }).group).toBe('watched');
    });
});

describe('WatchStore persistence', () => {
    it('survives a reopen', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ci-deck-db-'));
        const path = join(dir, 'nested', 'ci-deck.db');

        const first = WatchStore.open(path);
        first.addRepo(repo('alpha', 1));
        first.setPollPeriod(240);
        first.close();

        expect(existsSync(path)).toBe(true);

        const second = WatchStore.open(path);
        expect(second.listRepos().map((entry) => entry.name)).toEqual(['alpha']);
        expect(second.settings.pollPeriodSeconds).toBe(240);
        second.close();
    });

    it('is idempotent when migrations run twice', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ci-deck-db-'));
        const path = join(dir, 'ci-deck.db');

        const first = WatchStore.open(path);
        first.addRepo(repo('alpha', 1));
        first.close();

        const second = WatchStore.open(path);
        expect(second.count).toBe(1);
        second.close();
    });
});

describe('watch list sharing', () => {
    it('exports repos with everything needed to re-add them', () => {
        const store = WatchStore.memory();
        store.setPollPeriod(180);
        store.addRepo(repo('alpha', 1));

        const payload = store.exportList(HOST);

        expect(payload.version).toBe(2);
        expect(payload.settings.pollPeriodSeconds).toBe(180);
        expect(payload.repos).toEqual([
            {
                name: 'alpha',
                projectId: 1,
                path: 'group/alpha',
                ref: 'main',
                group: 'group',
                baseUrl: HOST,
                watched: true,
                tags: [],
            },
        ]);
    });

    it('never exports credentials', () => {
        const store = WatchStore.memory();
        store.setActiveBaseUrl(HOST);
        store.saveCredential(HOST, { kind: 'plaintext', ref: 'glpat-secret' }, 'me');
        store.addRepo(repo('alpha', 1));

        expect(JSON.stringify(store.exportList(HOST))).not.toContain('glpat-secret');
    });

    it('round-trips through parseExportFile', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));
        store.addRepo(repo('beta', 2));

        const parsed = parseExportFile(JSON.parse(JSON.stringify(store.exportList(HOST))));

        expect(parsed.map((entry) => entry.name)).toEqual(['alpha', 'beta']);
        expect(parsed[0]!.projectId).toBe(1);
    });

    it('accepts a bare array and bare strings', () => {
        expect(parseExportFile(['alpha', ' beta ', ''])).toEqual([{ name: 'alpha' }, { name: 'beta' }]);
    });

    it('accepts entries with only a path', () => {
        expect(parseExportFile({ repos: [{ path: 'group/sub/alpha' }] })).toEqual([
            { name: 'group/sub/alpha', path: 'group/sub/alpha' },
        ]);
    });

    it('reads a legacy config.json shaped file', () => {
        const legacy = { pollPeriodSeconds: 30, repos: [{ name: 'alpha', group: 'backend' }] };
        expect(parseExportFile(legacy)).toEqual([{ name: 'alpha', group: 'backend' }]);
    });

    it('skips entries with no usable identity', () => {
        expect(parseExportFile({ repos: [{ ref: 'main' }, null, 42] })).toEqual([]);
    });

    it('returns nothing for unrelated json', () => {
        expect(parseExportFile({ hello: 'world' })).toEqual([]);
    });
});

describe('WatchStore instances', () => {
    const OTHER = 'https://gitlab.other.com/';

    it('records the instance each repo was resolved against', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));

        expect(store.getRepo('alpha')!.baseUrl).toBe(HOST);
    });

    it('falls back to the active instance when none is given', () => {
        const store = WatchStore.memory();
        store.setActiveBaseUrl(OTHER);
        store.addRepo({ name: 'alpha', projectId: 1 });

        expect(store.getRepo('alpha')!.baseUrl).toBe(OTHER);
    });

    it('lists and counts repos per instance', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));
        store.addRepo({ ...repo('beta', 2), baseUrl: OTHER });

        expect(store.listReposFor(HOST).map((entry) => entry.name)).toEqual(['alpha']);
        expect(store.listReposFor(OTHER).map((entry) => entry.name)).toEqual(['beta']);
        expect(store.countFor(HOST)).toBe(1);
        expect(store.count).toBe(2);
    });

    it('keeps a stored active instance', () => {
        const store = WatchStore.memory();
        store.setActiveBaseUrl(HOST);
        expect(store.settings.activeBaseUrl).toBe(HOST);
    });
});

describe('WatchStore credentials', () => {
    it('has none by default', () => {
        expect(WatchStore.memory().getCredential(HOST)).toBeUndefined();
    });

    it('saves and reads back a credential reference', () => {
        const store = WatchStore.memory();
        const record = store.saveCredential(HOST, { kind: 'dpapi', ref: 'blob-data' }, 'zbahiva');

        expect(record.tokenKind).toBe('dpapi');
        expect(record.tokenRef).toBe('blob-data');
        expect(record.username).toBe('zbahiva');
        expect(record.validatedAt).not.toBeNull();
    });

    it('replaces the credential for the same instance', () => {
        const store = WatchStore.memory();
        store.saveCredential(HOST, { kind: 'plaintext', ref: 'first' }, 'me');
        store.saveCredential(HOST, { kind: 'plaintext', ref: 'second' }, 'me');

        expect(store.getCredential(HOST)!.tokenRef).toBe('second');
    });

    it('keeps credentials per instance', () => {
        const store = WatchStore.memory();
        store.saveCredential(HOST, { kind: 'plaintext', ref: 'one' }, 'me');
        store.saveCredential('https://gitlab.other.com/', { kind: 'plaintext', ref: 'two' }, 'me');

        expect(store.getCredential(HOST)!.tokenRef).toBe('one');
        expect(store.getCredential('https://gitlab.other.com/')!.tokenRef).toBe('two');
    });

    it('deletes a credential and reports when there was none', () => {
        const store = WatchStore.memory();
        store.saveCredential(HOST, { kind: 'plaintext', ref: 'one' }, 'me');

        expect(store.deleteCredential(HOST)).toBe(true);
        expect(store.deleteCredential(HOST)).toBe(false);
    });

    it('leaves the watch list alone when a credential is removed', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));
        store.saveCredential(HOST, { kind: 'plaintext', ref: 'one' }, 'me');
        store.deleteCredential(HOST);

        expect(store.count).toBe(1);
    });
});

describe('WatchStore watching', () => {
    it('watches a repo by default', () => {
        const store = WatchStore.memory();
        expect(store.addRepo(repo('alpha', 1)).watched).toBe(true);
    });

    it('honours an explicit paused state on add', () => {
        const store = WatchStore.memory();
        expect(store.addRepo({ ...repo('alpha', 1), watched: false }).watched).toBe(false);
    });

    it('toggles watching and reports an unknown repo', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));

        expect(store.setWatched('alpha', false)).toBe(true);
        expect(store.getRepo('alpha')!.watched).toBe(false);
        expect(store.setWatched('alpha', true)).toBe(true);
        expect(store.getRepo('alpha')!.watched).toBe(true);
        expect(store.setWatched('nope', false)).toBe(false);
    });

    it('sorts paused repos to the bottom, keeping order within each group', () => {
        const store = WatchStore.memory();
        for (const name of ['alpha', 'beta', 'gamma', 'delta']) {
            store.addRepo(repo(name, 1));
        }
        store.setWatched('beta', false);
        store.setWatched('alpha', false);

        expect(store.listRepos().map((entry) => entry.name)).toEqual(['gamma', 'delta', 'alpha', 'beta']);
        expect(store.listReposFor(HOST).map((entry) => entry.name)).toEqual(['gamma', 'delta', 'alpha', 'beta']);
    });

    it('keeps the paused state through an export and import round trip', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));
        store.setWatched('alpha', false);

        const parsed = parseExportFile(JSON.parse(JSON.stringify(store.exportList(HOST))));
        expect(parsed[0]!.watched).toBe(false);
    });

    it('survives a reopen with the paused state intact', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ci-deck-db-'));
        const path = join(dir, 'ci-deck.db');

        const first = WatchStore.open(path);
        first.addRepo(repo('alpha', 1));
        first.setWatched('alpha', false);
        first.close();

        const second = WatchStore.open(path);
        expect(second.getRepo('alpha')!.watched).toBe(false);
        second.close();
    });
});

describe('tags', () => {
    const HOST_A = 'https://gitlab.example.com/';
    const HOST_B = 'https://other.example.com/';

    function seeded() {
        const store = WatchStore.memory();
        store.setActiveBaseUrl(HOST_A);
        for (const name of ['alpha', 'beta', 'gamma']) {
            store.addRepo({ name, projectId: name.length, baseUrl: HOST_A });
        }
        return store;
    }

    it('creates a tag once, however often it is asked for', () => {
        const store = seeded();
        store.createTag(HOST_A, 'backs');
        store.createTag(HOST_A, 'backs');

        expect(store.listTags(HOST_A)).toEqual([{ name: 'backs', count: 0 }]);
    });

    it('puts one repo in several tags and one tag on several repos', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['lib', 'backs', 'CRUDs']);
        store.setRepoTags(HOST_A, 'beta', ['lib', 'backs']);

        expect(store.tagsByRepo(HOST_A).get('alpha')).toEqual(['lib', 'backs', 'CRUDs']);
        expect(store.listTags(HOST_A)).toEqual([
            { name: 'lib', count: 2 },
            { name: 'backs', count: 2 },
            { name: 'CRUDs', count: 1 },
        ]);
    });

    it('replaces a repo\'s tags rather than adding to them', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['lib', 'backs']);
        store.setRepoTags(HOST_A, 'alpha', ['front']);

        expect(store.tagsByRepo(HOST_A).get('alpha')).toEqual(['front']);
    });

    it('merges when adding, which is how import leaves a watched repo alone', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['lib']);
        store.addRepoTags(HOST_A, 'alpha', ['backs', 'lib']);

        expect(store.tagsByRepo(HOST_A).get('alpha')).toEqual(['lib', 'backs']);
    });

    it('sets a whole membership in one call, ignoring repos not on the board', () => {
        const store = seeded();
        store.createTag(HOST_A, 'backs');

        expect(store.setTagRepos(HOST_A, 'backs', ['alpha', 'gamma', 'nope'])).toEqual(['alpha', 'gamma']);
        expect(store.listTags(HOST_A)).toEqual([{ name: 'backs', count: 2 }]);
    });

    it('renames a tag and carries its memberships across', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['backs']);

        expect(store.renameTag(HOST_A, 'backs', 'backend')).toBe(true);
        expect(store.tagsByRepo(HOST_A).get('alpha')).toEqual(['backend']);
    });

    it('refuses a rename onto a tag that already exists', () => {
        const store = seeded();
        store.createTag(HOST_A, 'backs');
        store.createTag(HOST_A, 'front');

        expect(() => store.renameTag(HOST_A, 'backs', 'front')).toThrow(/already exists/);
    });

    it('drops memberships when the tag goes', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['backs', 'lib']);
        store.deleteTag(HOST_A, 'backs');

        expect(store.tagsByRepo(HOST_A).get('alpha')).toEqual(['lib']);
    });

    it('drops memberships when the repo goes', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['backs']);
        store.removeRepo('alpha');

        expect(store.tagsByRepo(HOST_A).size).toBe(0);
        expect(store.listTags(HOST_A)).toEqual([{ name: 'backs', count: 0 }]);
    });

    it('keeps tags on separate instances apart', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['backs']);
        store.createTag(HOST_B, 'other');

        expect(store.listTags(HOST_A).map((t) => t.name)).toEqual(['backs']);
        expect(store.listTags(HOST_B).map((t) => t.name)).toEqual(['other']);
    });

    it('remembers the active tags and the sweep scope', () => {
        const store = seeded();

        expect(store.settings.activeTags).toEqual([]);
        expect(store.settings.scopeSweepToTags).toBe(false);

        store.setActiveTags(['  backs ', 'lib', 'backs', '']);
        store.setScopeSweepToTags(true);

        expect(store.settings.activeTags).toEqual(['backs', 'lib']);
        expect(store.settings.scopeSweepToTags).toBe(true);
    });

    it('carries tags through an export, including ones nothing uses', () => {
        const store = seeded();
        store.setRepoTags(HOST_A, 'alpha', ['lib', 'backs']);
        store.createTag(HOST_A, 'unused');

        const file = store.exportList(HOST_A);

        expect(file.version).toBe(2);
        expect(file.tags).toEqual(['lib', 'backs', 'unused']);
        expect(file.repos.find((r) => r.name === 'alpha')?.tags).toEqual(['lib', 'backs']);
        expect(file.repos.find((r) => r.name === 'beta')?.tags).toEqual([]);
    });
});
