import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COLUMN_WIDTHS } from '../src/shared/types.ts';
import {
    DEFAULT_SETTINGS,
    MAX_POLL_SECONDS,
    MIN_POLL_SECONDS,
    parseExportFile,
    parseExportTags,
    StoreError,
    WatchStore,
} from '../src/store/watch-store.ts';

const HOST = 'https://gitlab.example.com/';

/** A tag nobody has given a description or a colour, which is most of them. */
const plainTag = (name: string, count: number) => ({ name, count, description: null, color: null });

const repo = (name: string, projectId: number) => ({
    name,
    projectId,
    path: `group/${name}`,
    group: 'group',
    baseUrl: HOST,
});

describe('WatchStore.open', () => {
    // The container case, where a mounted volume belongs to another user, arrives
    // as SQLite's "unable to open database file" and explains nothing.
    it('says what could not be opened rather than passing SQLite along', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ci-deck-open-'));
        const notADirectory = join(dir, 'file');
        await Bun.write(notADirectory, 'x');

        expect(() => WatchStore.open(join(notADirectory, 'ci-deck.db'))).toThrow(StoreError);
        expect(() => WatchStore.open(join(notADirectory, 'ci-deck.db'))).toThrow(/Cannot open the database at/);
    });
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

    it('keeps the switches the config window sets', () => {
        const store = WatchStore.memory();

        store.setConfirmManualRun(false);
        store.setNotifications('snooze');
        store.setTheme('light');

        expect(store.settings.confirmManualRun).toBe(false);
        expect(store.settings.notifications).toBe('snooze');
        expect(store.settings.theme).toBe('light');
    });
});

describe('WatchStore column widths', () => {
    it('merges one column over the rest, so a drag need not send them all', () => {
        const store = WatchStore.memory();

        const merged = store.setColumnWidths({ stages: 420 });

        expect(merged.stages).toBe(420);
        expect(merged.repo).toBe(DEFAULT_COLUMN_WIDTHS.repo);
        expect(store.settings.columnWidths.stages).toBe(420);
    });

    it('clamps a width nobody could use', () => {
        const store = WatchStore.memory();

        expect(store.setColumnWidths({ status: 2 }).status).toBe(48);
        expect(store.setColumnWidths({ status: 9_000 }).status).toBe(900);
    });

    it('falls back to the defaults when the stored value is nonsense', () => {
        const store = WatchStore.memory();
        store.setColumnWidths({ stages: 300 });
        // Whatever a hand-edited database might contain.
        store.setColumnWidths({ stages: Number.NaN });

        expect(store.settings.columnWidths.stages).toBe(300);
    });
});

describe('WatchStore repos', () => {
    it('adds a repo and reads it back', () => {
        const store = WatchStore.memory();
        const record = store.addRepo(repo('alpha', 1));

        expect(record).toEqual({
            id: record.id,
            name: 'alpha',
            projectId: 1,
            path: 'group/alpha',
            ref: DEFAULT_SETTINGS.defaultRef,
            group: 'group',
            position: 1,
            baseUrl: HOST,
            watched: true,
            notify: 'on',
            branchMissing: false,
        });
        expect(store.getRepo(record.id)).toEqual(record);
    });

    it('applies the stored default ref to new repos', () => {
        const store = WatchStore.memory();
        store.setDefaultRef('trunk');

        expect(store.addRepo(repo('alpha', 1)).ref).toBe('trunk');
        expect(store.addRepo({ ...repo('beta', 2), ref: 'release' }).ref).toBe('release');
    });

    it('files rows by name and branch, so two branches of a repo sit together', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('zulu', 1));
        store.addRepo({ ...repo('alpha', 2), ref: 'release' });
        store.addRepo(repo('mike', 3));
        store.addRepo(repo('alpha', 2));

        expect(store.listRepos().map((entry) => `${entry.name}@${entry.ref}`))
            .toEqual(['alpha@main', 'alpha@release', 'mike@main', 'zulu@main']);
    });

    it('refuses the same repo on the same branch twice', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));

        expect(() => store.addRepo(repo('alpha', 1))).toThrow(/already watched on main/);
    });

    /** The whole point of the surrogate key: a name no longer names a row. */
    it('takes the same repo again on a different branch', () => {
        const store = WatchStore.memory();
        const main = store.addRepo(repo('alpha', 1));
        const develop = store.addRepo({ ...repo('alpha', 1), ref: 'develop' });

        expect(develop.id).not.toBe(main.id);
        expect(store.refsFor(HOST, 1)).toEqual(['develop', 'main']);
    });

    it('keeps the same name apart on separate instances', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));
        store.addRepo({ ...repo('alpha', 9), baseUrl: 'https://other.example.com/' });

        expect(store.count).toBe(2);
        expect(store.listReposFor(HOST)).toHaveLength(1);
    });

    it('removes a row and reports when there was nothing to remove', () => {
        const store = WatchStore.memory();
        const alpha = store.addRepo(repo('alpha', 1));

        expect(store.removeRepo(alpha.id)).toBe(true);
        expect(store.removeRepo(alpha.id)).toBe(false);
        expect(store.count).toBe(0);
    });

    it('finds a row by the three things that identify it', () => {
        const store = WatchStore.memory();
        store.addRepo({ ...repo('alpha', 1), ref: 'develop' });

        expect(store.findRepo(HOST, 'alpha', 'develop')).toBeDefined();
        expect(store.findRepo(HOST, 'alpha', 'main')).toBeUndefined();
        expect(store.findRepo('https://other.example.com/', 'alpha', 'develop')).toBeUndefined();
    });

    it('defaults the group when none is given', () => {
        const store = WatchStore.memory();
        expect(store.addRepo({ name: 'alpha', projectId: 1 }).group).toBe('watched');
    });

    it('records a branch that has gone missing', () => {
        const store = WatchStore.memory();
        const alpha = store.addRepo({ ...repo('alpha', 1), ref: 'feature/x' });

        expect(store.setBranchMissing(alpha.id, true)).toBe(true);
        expect(store.getRepo(alpha.id)!.branchMissing).toBe(true);
        expect(store.setBranchMissing(999, true)).toBe(false);
    });

    it('stores a per-row notification mode', () => {
        const store = WatchStore.memory();
        const alpha = store.addRepo(repo('alpha', 1));

        expect(store.setNotify(alpha.id, 'snooze')).toBe(true);
        expect(store.getRepo(alpha.id)!.notify).toBe('snooze');
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

/**
 * The one migration that rebuilds tables rather than adding a column, and the one
 * that would lose a watch list if it were wrong. The old schema is written out
 * here rather than imported: it is history, so it cannot change, and a copy is
 * exactly what a real upgrade is reading.
 */
describe('migrating a database keyed by name', () => {
    async function legacyDatabase(): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), 'ci-deck-migrate-'));
        const path = join(dir, 'ci-deck.db');
        const db = new Database(path, { create: true });

        db.exec(`
            CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE repos (
                name TEXT PRIMARY KEY,
                project_id INTEGER NOT NULL,
                path TEXT,
                ref TEXT NOT NULL,
                grp TEXT NOT NULL DEFAULT 'watched',
                position INTEGER NOT NULL,
                added_at TEXT NOT NULL,
                base_url TEXT NOT NULL DEFAULT '',
                web_url TEXT,
                watched INTEGER NOT NULL DEFAULT 1
            );
            CREATE TABLE credentials (
                base_url TEXT PRIMARY KEY, token_kind TEXT NOT NULL, token_ref TEXT NOT NULL,
                username TEXT, validated_at TEXT, created_at TEXT NOT NULL
            );
            CREATE TABLE tags (
                name TEXT NOT NULL, base_url TEXT NOT NULL, position INTEGER NOT NULL,
                created_at TEXT NOT NULL, PRIMARY KEY (name, base_url)
            );
            CREATE TABLE repo_tags (
                repo_name TEXT NOT NULL, tag_name TEXT NOT NULL, base_url TEXT NOT NULL,
                PRIMARY KEY (repo_name, tag_name, base_url)
            );
            INSERT INTO repos (name, project_id, path, ref, grp, position, added_at, base_url, watched)
            VALUES
                ('alpha', 1, 'group/alpha', 'main', 'group', 1, '2026-01-01T00:00:00Z', '${HOST}', 1),
                ('beta', 2, 'group/beta', 'develop', 'group', 2, '2026-01-01T00:00:00Z', '${HOST}', 0);
            INSERT INTO tags (name, base_url, position, created_at)
            VALUES ('backs', '${HOST}', 1, '2026-01-01T00:00:00Z');
            INSERT INTO repo_tags (repo_name, tag_name, base_url) VALUES ('alpha', 'backs', '${HOST}');
            INSERT INTO settings (key, value) VALUES ('activeTags', '["backs"]'), ('scopeSweepToTags', '1');
            PRAGMA user_version = 4;
        `);
        db.close();
        return path;
    }

    it('gives every row an id and keeps what it had', async () => {
        const store = WatchStore.open(await legacyDatabase());
        const rows = store.listReposFor(HOST);

        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.name).sort()).toEqual(['alpha', 'beta']);
        expect(rows.every((row) => Number.isInteger(row.id) && row.id > 0)).toBe(true);

        const beta = store.findRepo(HOST, 'beta', 'develop')!;
        expect(beta.watched).toBe(false);
        // Columns the rebuild introduced take their defaults, not null.
        expect(beta.notify).toBe('on');
        expect(beta.branchMissing).toBe(false);
        store.close();
    });

    it('carries tag memberships onto the new keys', async () => {
        const store = WatchStore.open(await legacyDatabase());
        const alpha = store.findRepo(HOST, 'alpha', 'main')!;

        expect(store.tagsByRepo(HOST).get(alpha.id)).toEqual(['backs']);
        expect(store.listTags(HOST)).toEqual([plainTag('backs', 1)]);
        store.close();
    });

    it('drops the settings that no longer have a reader', async () => {
        const path = await legacyDatabase();
        const store = WatchStore.open(path);
        store.close();

        const db = new Database(path);
        const left = db.query<{ key: string }, []>('SELECT key FROM settings').all();
        db.close();

        expect(left.map((row) => row.key)).toEqual([]);
    });

    it('cascades a removal on the rebuilt foreign key', async () => {
        const store = WatchStore.open(await legacyDatabase());
        const alpha = store.findRepo(HOST, 'alpha', 'main')!;

        store.removeRepo(alpha.id);

        expect(store.tagsByRepo(HOST).size).toBe(0);
        store.close();
    });
});

describe('watch list sharing', () => {
    it('exports repos with everything needed to re-add them', () => {
        const store = WatchStore.memory();
        store.setPollPeriod(180);
        store.addRepo(repo('alpha', 1));

        const payload = store.exportList(HOST);

        expect(payload.version).toBe(4);
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
                notify: 'on',
                tags: [],
            },
        ]);
    });

    it('carries a repo once per branch, which is what a row is', () => {
        const store = WatchStore.memory();
        store.addRepo(repo('alpha', 1));
        store.addRepo({ ...repo('alpha', 1), ref: 'develop' });

        expect(store.exportList(HOST).repos.map((entry) => entry.ref)).toEqual(['develop', 'main']);
    });

    /**
     * An export is a file people hand to each other. A board that also watches an
     * internal instance must not put that host, or the paths of everything on it,
     * into a file exported from a public one.
     */
    it('exports only the instance it was asked for', () => {
        const store = WatchStore.memory();
        store.addRepo({ name: 'internal-thing', projectId: 1, path: 'corp/internal-thing', baseUrl: HOST });
        store.addRepo({ name: 'public-thing', projectId: 2, path: 'me/public-thing', baseUrl: 'https://gitlab.com/' });

        const payload = store.exportList('https://gitlab.com/');

        expect(payload.repos.map((entry) => entry.name)).toEqual(['public-thing']);
        expect(JSON.stringify(payload)).not.toContain('internal-thing');
        expect(JSON.stringify(payload)).not.toContain(HOST);
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

    it('carries a tag’s description and colour through a round trip', () => {
        const store = WatchStore.memory();
        store.createTag(HOST, 'backs', { description: 'Backend services', color: '#1f75cb' });

        const parsed = parseExportTags(JSON.parse(JSON.stringify(store.exportList(HOST))));

        expect(parsed).toEqual([{ name: 'backs', description: 'Backend services', color: '#1f75cb' }]);
    });

    /** Version 3 files list tags as bare names, and still import as tags. */
    it('reads a tag list of plain strings', () => {
        expect(parseExportTags({ tags: ['lib', ' backs ', ''] }))
            .toEqual([{ name: 'lib' }, { name: 'backs' }]);
    });

    it('takes a tag a repo names but the file never declared', () => {
        expect(parseExportTags({ tags: ['lib'], repos: [{ name: 'alpha', tags: ['lib', 'backs'] }] }))
            .toEqual([{ name: 'lib' }, { name: 'backs' }]);
    });

    it('drops a colour a file made up', () => {
        expect(parseExportTags({ tags: [{ name: 'lib', color: 'rebeccapurple' }] }))
            .toEqual([{ name: 'lib' }]);
    });

    it('fills a tag’s blanks on import without repainting one already set', () => {
        const store = WatchStore.memory();
        store.createTag(HOST, 'backs', { color: '#d1392b' });

        store.mergeTag(HOST, 'backs', { description: 'Backend services', color: '#1f75cb' });
        store.mergeTag(HOST, 'front', { color: '#2d8a4e' });

        expect(store.listTags(HOST)).toEqual([
            { name: 'backs', count: 0, description: 'Backend services', color: '#d1392b' },
            { name: 'front', count: 0, description: null, color: '#2d8a4e' },
        ]);
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

    it('keeps a notification mode it recognises and drops one it does not', () => {
        expect(parseExportFile({ repos: [{ name: 'a', notify: 'snooze' }, { name: 'b', notify: 'loud' }] }))
            .toEqual([{ name: 'a', notify: 'snooze' }, { name: 'b' }]);
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
        const alpha = store.addRepo(repo('alpha', 1));

        expect(store.getRepo(alpha.id)!.baseUrl).toBe(HOST);
    });

    it('falls back to the active instance when none is given', () => {
        const store = WatchStore.memory();
        store.setActiveBaseUrl(OTHER);
        const alpha = store.addRepo({ name: 'alpha', projectId: 1 });

        expect(store.getRepo(alpha.id)!.baseUrl).toBe(OTHER);
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

    it('toggles watching and reports an unknown row', () => {
        const store = WatchStore.memory();
        const alpha = store.addRepo(repo('alpha', 1));

        expect(store.setWatched(alpha.id, false)).toBe(true);
        expect(store.getRepo(alpha.id)!.watched).toBe(false);
        expect(store.setWatched(alpha.id, true)).toBe(true);
        expect(store.getRepo(alpha.id)!.watched).toBe(true);
        expect(store.setWatched(999, false)).toBe(false);
    });

    it('sorts paused rows to the bottom, alphabetically within each half', () => {
        const store = WatchStore.memory();
        const ids = new Map(
            ['alpha', 'beta', 'gamma', 'delta'].map((name, index) => [name, store.addRepo(repo(name, index + 1)).id]),
        );
        store.setWatched(ids.get('beta')!, false);
        store.setWatched(ids.get('alpha')!, false);

        expect(store.listRepos().map((entry) => entry.name)).toEqual(['delta', 'gamma', 'alpha', 'beta']);
        expect(store.listReposFor(HOST).map((entry) => entry.name)).toEqual(['delta', 'gamma', 'alpha', 'beta']);
    });

    it('keeps the paused state through an export and import round trip', () => {
        const store = WatchStore.memory();
        const alpha = store.addRepo(repo('alpha', 1));
        store.setWatched(alpha.id, false);

        const parsed = parseExportFile(JSON.parse(JSON.stringify(store.exportList(HOST))));
        expect(parsed[0]!.watched).toBe(false);
    });

    it('survives a reopen with the paused state intact', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'ci-deck-db-'));
        const path = join(dir, 'ci-deck.db');

        const first = WatchStore.open(path);
        const alpha = first.addRepo(repo('alpha', 1));
        first.setWatched(alpha.id, false);
        first.close();

        const second = WatchStore.open(path);
        expect(second.findRepo(HOST, 'alpha', 'main')!.watched).toBe(false);
        second.close();
    });
});

describe('tags', () => {
    const HOST_A = 'https://gitlab.example.com/';
    const HOST_B = 'https://other.example.com/';

    function seeded() {
        const store = WatchStore.memory();
        store.setActiveBaseUrl(HOST_A);
        const ids = new Map(
            ['alpha', 'beta', 'gamma'].map((name) => [
                name,
                store.addRepo({ name, projectId: name.length, baseUrl: HOST_A }).id,
            ]),
        );
        return { store, id: (name: string) => ids.get(name)! };
    }

    it('creates a tag once, however often it is asked for', () => {
        const { store } = seeded();
        store.createTag(HOST_A, 'backs');
        store.createTag(HOST_A, 'backs');

        expect(store.listTags(HOST_A)).toEqual([plainTag('backs', 0)]);
    });

    it('keeps a description and a colour against the tag', () => {
        const { store } = seeded();
        store.createTag(HOST_A, 'backs', { description: '  Backend services  ', color: '#1F75CB' });

        expect(store.listTags(HOST_A)).toEqual([
            { name: 'backs', count: 0, description: 'Backend services', color: '#1f75cb' },
        ]);
    });

    /** Anything that is not six hex digits is no colour at all, not a stored string. */
    it('drops a colour that is not a hex triplet', () => {
        const { store } = seeded();
        store.createTag(HOST_A, 'backs', { color: 'rebeccapurple' });
        store.createTag(HOST_A, 'front', { color: '#abc' });

        expect(store.listTags(HOST_A).map((tag) => tag.color)).toEqual([null, null]);
    });

    it('writes the fields an update names and leaves out the ones it does not', () => {
        const { store } = seeded();
        store.createTag(HOST_A, 'backs', { description: 'Backend services', color: '#1f75cb' });

        store.updateTag(HOST_A, 'backs', { color: '#d1392b' });

        expect(store.listTags(HOST_A)).toEqual([
            { name: 'backs', count: 0, description: 'Backend services', color: '#d1392b' },
        ]);
    });

    it('clears a description asked to be cleared, rather than ignoring the null', () => {
        const { store } = seeded();
        store.createTag(HOST_A, 'backs', { description: 'Backend services' });

        store.updateTag(HOST_A, 'backs', { description: null });

        expect(store.listTags(HOST_A)[0]!.description).toBeNull();
    });

    it('renames and recolours in one call, carrying the memberships across', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['backs']);

        expect(store.updateTag(HOST_A, 'backs', { name: 'backend', color: '#2d8a4e' })).toBe(true);
        expect(store.tagsByRepo(HOST_A).get(id('alpha'))).toEqual(['backend']);
        expect(store.listTags(HOST_A)).toEqual([
            { name: 'backend', count: 1, description: null, color: '#2d8a4e' },
        ]);
    });

    it('reports an update to a tag that is not there', () => {
        const { store } = seeded();
        expect(store.updateTag(HOST_A, 'nothing', { color: '#2d8a4e' })).toBe(false);
    });

    it('puts one row in several tags and one tag on several rows', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['lib', 'backs', 'CRUDs']);
        store.setRepoTags(HOST_A, id('beta'), ['lib', 'backs']);

        expect(store.tagsByRepo(HOST_A).get(id('alpha'))).toEqual(['lib', 'backs', 'CRUDs']);
        expect(store.listTags(HOST_A)).toEqual([
            plainTag('lib', 2),
            plainTag('backs', 2),
            plainTag('CRUDs', 1),
        ]);
    });

    /** Two branches of one repo are two rows, and tag independently. */
    it('tags a branch rather than a repo', () => {
        const { store, id } = seeded();
        const develop = store.addRepo({ name: 'alpha', projectId: 5, ref: 'develop', baseUrl: HOST_A });

        store.setRepoTags(HOST_A, id('alpha'), ['release-blocking']);

        expect(store.tagsByRepo(HOST_A).get(id('alpha'))).toEqual(['release-blocking']);
        expect(store.tagsByRepo(HOST_A).get(develop.id)).toBeUndefined();
    });

    it('replaces a row\'s tags rather than adding to them', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['lib', 'backs']);
        store.setRepoTags(HOST_A, id('alpha'), ['front']);

        expect(store.tagsByRepo(HOST_A).get(id('alpha'))).toEqual(['front']);
    });

    it('merges when adding, which is how import leaves a watched row alone', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['lib']);
        store.addRepoTags(HOST_A, id('alpha'), ['backs', 'lib']);

        expect(store.tagsByRepo(HOST_A).get(id('alpha'))).toEqual(['lib', 'backs']);
    });

    it('sets a whole membership in one call, ignoring rows not on the board', () => {
        const { store, id } = seeded();
        store.createTag(HOST_A, 'backs');

        expect(store.setTagRepos(HOST_A, 'backs', [id('alpha'), id('gamma'), 999]))
            .toEqual([id('alpha'), id('gamma')]);
        expect(store.listTags(HOST_A)).toEqual([plainTag('backs', 2)]);
    });

    it('renames a tag and carries its memberships across', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['backs']);

        expect(store.renameTag(HOST_A, 'backs', 'backend')).toBe(true);
        expect(store.tagsByRepo(HOST_A).get(id('alpha'))).toEqual(['backend']);
    });

    it('refuses a rename onto a tag that already exists', () => {
        const { store } = seeded();
        store.createTag(HOST_A, 'backs');
        store.createTag(HOST_A, 'front');

        expect(() => store.renameTag(HOST_A, 'backs', 'front')).toThrow(/already exists/);
    });

    it('drops memberships when the tag goes', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['backs', 'lib']);
        store.deleteTag(HOST_A, 'backs');

        expect(store.tagsByRepo(HOST_A).get(id('alpha'))).toEqual(['lib']);
    });

    it('drops memberships when the row goes', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['backs']);
        store.removeRepo(id('alpha'));

        expect(store.tagsByRepo(HOST_A).size).toBe(0);
        expect(store.listTags(HOST_A)).toEqual([plainTag('backs', 0)]);
    });

    it('keeps tags on separate instances apart', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['backs']);
        store.createTag(HOST_B, 'other');

        expect(store.listTags(HOST_A).map((t) => t.name)).toEqual(['backs']);
        expect(store.listTags(HOST_B).map((t) => t.name)).toEqual(['other']);
    });

    it('carries tags through an export, including ones nothing uses', () => {
        const { store, id } = seeded();
        store.setRepoTags(HOST_A, id('alpha'), ['lib', 'backs']);
        store.createTag(HOST_A, 'unused');

        const file = store.exportList(HOST_A);

        expect(file.version).toBe(4);
        expect(file.tags).toEqual([{ name: 'lib' }, { name: 'backs' }, { name: 'unused' }]);
        expect(file.repos.find((r) => r.name === 'alpha')?.tags).toEqual(['lib', 'backs']);
        expect(file.repos.find((r) => r.name === 'beta')?.tags).toEqual([]);
    });
});
