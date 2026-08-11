import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretKind, StoredSecret } from '../config/secrets.ts';
import { EXPORT_VERSION, type ExportFile, normaliseTags } from '../shared/watchlist.ts';

// The format itself lives in shared/ so the browser can parse a file the same
// way; re-exported here because that is where callers already look for it.
export { EXPORT_VERSION, normaliseTags, parseExportFile, parseExportTags } from '../shared/watchlist.ts';
export type { ExportedRepo, ExportFile } from '../shared/watchlist.ts';

/** The database could not be opened — which is fatal, and rarely SQLite's fault. */
export class StoreError extends Error { }

/** A stored settings value that should be a JSON array of tag names. */
function parseStoredTags(raw: string | undefined): string[] {
    if (!raw) return [];
    try {
        return normaliseTags(JSON.parse(raw));
    } catch {
        return [];
    }
}

export interface RepoRecord {
    name: string;
    projectId: number;
    path: string | null;
    ref: string;
    group: string;
    position: number;
    /** GitLab instance this repo was resolved against. */
    baseUrl: string;
    webUrl: string | null;
    /** False keeps the repo on the board but out of the periodic sweep. */
    watched: boolean;
}

export interface NewRepo {
    name: string;
    projectId: number;
    path?: string | null;
    ref?: string;
    group?: string;
    baseUrl?: string;
    webUrl?: string | null;
    watched?: boolean;
}

export interface StoreSettings {
    pollPeriodSeconds: number;
    defaultRef: string;
    retries: number;
    /** Instance the board is currently pointed at, when one has been configured. */
    activeBaseUrl: string | null;
    /** Tags currently filtering the board. Kept server-side so the sweep can use them. */
    activeTags: string[];
    /** When true the sweep walks only the repos carrying an active tag. */
    scopeSweepToTags: boolean;
}

export interface TagRecord {
    name: string;
    /** Repos carrying it, on the active instance. */
    count: number;
}

export interface CredentialRecord {
    baseUrl: string;
    tokenKind: SecretKind;
    tokenRef: string;
    username: string | null;
    validatedAt: string | null;
}

export const DEFAULT_SETTINGS: StoreSettings = {
    pollPeriodSeconds: 120,
    defaultRef: 'main',
    retries: 5,
    activeBaseUrl: null,
    activeTags: [],
    scopeSweepToTags: false,
};

export const MIN_POLL_SECONDS = 10;
export const MAX_POLL_SECONDS = 3_600;

export function clampPollPeriod(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), MIN_POLL_SECONDS), MAX_POLL_SECONDS);
}

interface RepoRow {
    name: string;
    project_id: number;
    path: string | null;
    ref: string;
    grp: string;
    position: number;
    base_url: string;
    web_url: string | null;
    watched: number;
}

interface CredentialRow {
    base_url: string;
    token_kind: string;
    token_ref: string;
    username: string | null;
    validated_at: string | null;
}

const MIGRATIONS = [
    `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS repos (
        name TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        path TEXT,
        ref TEXT NOT NULL,
        grp TEXT NOT NULL DEFAULT 'watched',
        position INTEGER NOT NULL,
        added_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS repos_position ON repos (position);`,

    // Per-repo instance metadata, and somewhere to keep credentials per instance.
    `ALTER TABLE repos ADD COLUMN base_url TEXT NOT NULL DEFAULT '';
    ALTER TABLE repos ADD COLUMN web_url TEXT;
    CREATE TABLE IF NOT EXISTS credentials (
        base_url TEXT PRIMARY KEY,
        token_kind TEXT NOT NULL,
        token_ref TEXT NOT NULL,
        username TEXT,
        validated_at TEXT,
        created_at TEXT NOT NULL
    );`,

    // Paused repos stay on the board but are skipped by the sweep.
    `ALTER TABLE repos ADD COLUMN watched INTEGER NOT NULL DEFAULT 1;`,

    // Tags: many-to-many and hand-curated, alongside the namespace `grp` a repo
    // is filed under. Both tables are keyed by instance like everything else, and
    // the cascades mean removing a repo or a tag cleans up its memberships.
    `CREATE TABLE IF NOT EXISTS tags (
        name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (name, base_url)
    );
    CREATE TABLE IF NOT EXISTS repo_tags (
        repo_name TEXT NOT NULL,
        tag_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        PRIMARY KEY (repo_name, tag_name, base_url),
        FOREIGN KEY (repo_name) REFERENCES repos (name) ON DELETE CASCADE,
        -- ON UPDATE too, so renaming a tag carries its memberships instead of
        -- orphaning them the moment the name changes.
        FOREIGN KEY (tag_name, base_url) REFERENCES tags (name, base_url)
            ON DELETE CASCADE ON UPDATE CASCADE
    );
    CREATE INDEX IF NOT EXISTS repo_tags_tag ON repo_tags (base_url, tag_name);`,
];

/**
 * The watch list and settings, kept in SQLite so an add or remove is a single
 * statement instead of a whole-file rewrite. Starts empty on a cold install.
 */
export class WatchStore {
    readonly path: string;
    private readonly db: Database;

    private constructor(db: Database, path: string) {
        this.db = db;
        this.path = path;
        // Here rather than in `open`, so an in-memory store cascades identically —
        // otherwise tests would see tag memberships outlive the repos they belong to.
        this.db.exec('PRAGMA foreign_keys = ON;');
        this.migrate();
    }

    static open(path: string): WatchStore {
        try {
            if (path !== ':memory:') {
                const dir = dirname(path);
                mkdirSync(dir, { recursive: true });
                // The token can live here; keep the directory to the owner where modes apply.
                // Windows relies on the default ACL of %LOCALAPPDATA% instead.
                if (process.platform !== 'win32') {
                    try {
                        chmodSync(dir, 0o700);
                    } catch {
                        // Not fatal: an unusual filesystem should not stop the app.
                    }
                }
            }
            const db = new Database(path, { create: true });
            db.exec('PRAGMA journal_mode = WAL;');
            return new WatchStore(db, path);
        } catch (error) {
            // SQLite says "unable to open database file" and leaves you to guess
            // which of the several reasons it was. A mounted volume owned by
            // someone else is the usual one, and says nothing about SQLite at all.
            const reason = error instanceof Error ? error.message : String(error);
            const asUser = process.getuid ? ` It runs as uid ${process.getuid()}.` : '';
            throw new StoreError(
                `Cannot open the database at ${path} — ${reason}\n\n`
                + `It has to sit in a directory this process can write to.${asUser}`,
                { cause: error },
            );
        }
    }

    static memory(): WatchStore {
        return new WatchStore(new Database(':memory:'), ':memory:');
    }

    private migrate(): void {
        const current = Number(this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? 0);

        for (let version = current; version < MIGRATIONS.length; version += 1) {
            this.db.exec(MIGRATIONS[version]!);
        }
        if (current < MIGRATIONS.length) this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    }

    close(): void {
        this.db.close();
    }

    // --- settings ---

    get settings(): StoreSettings {
        const rows = this.db.query<{ key: string; value: string }, []>('SELECT key, value FROM settings').all();
        const stored = new Map(rows.map((row) => [row.key, row.value]));

        const number = (key: keyof StoreSettings, fallback: number) => {
            const parsed = Number.parseInt(stored.get(key) ?? '', 10);
            return Number.isInteger(parsed) ? parsed : fallback;
        };

        return {
            pollPeriodSeconds: clampPollPeriod(
                number('pollPeriodSeconds', DEFAULT_SETTINGS.pollPeriodSeconds),
                DEFAULT_SETTINGS.pollPeriodSeconds,
            ),
            defaultRef: stored.get('defaultRef')?.trim() || DEFAULT_SETTINGS.defaultRef,
            retries: number('retries', DEFAULT_SETTINGS.retries),
            activeBaseUrl: stored.get('activeBaseUrl')?.trim() || null,
            activeTags: parseStoredTags(stored.get('activeTags')),
            scopeSweepToTags: stored.get('scopeSweepToTags') === '1',
        };
    }

    setActiveBaseUrl(baseUrl: string): void {
        this.putSetting('activeBaseUrl', baseUrl);
    }

    /** Kept server-side, not in the browser, because the sweep reads it too. */
    setActiveTags(tags: string[]): string[] {
        const applied = normaliseTags(tags);
        this.putSetting('activeTags', JSON.stringify(applied));
        return applied;
    }

    setScopeSweepToTags(scoped: boolean): boolean {
        this.putSetting('scopeSweepToTags', scoped ? '1' : '0');
        return scoped;
    }

    private putSetting(key: string, value: string): void {
        this.db
            .query('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
            .run(key, value);
    }

    setPollPeriod(seconds: number): number {
        const applied = clampPollPeriod(seconds, this.settings.pollPeriodSeconds);
        this.putSetting('pollPeriodSeconds', String(applied));
        return applied;
    }

    setDefaultRef(ref: string): string {
        const applied = ref.trim() || DEFAULT_SETTINGS.defaultRef;
        this.putSetting('defaultRef', applied);
        return applied;
    }

    // --- repos ---

    private static toRecord(row: RepoRow): RepoRecord {
        return {
            name: row.name,
            projectId: row.project_id,
            path: row.path,
            ref: row.ref,
            group: row.grp,
            position: row.position,
            baseUrl: row.base_url,
            webUrl: row.web_url,
            watched: row.watched === 1,
        };
    }

    /** Watched repos first, so paused ones collect at the bottom of the board. */
    private static readonly ORDER = 'ORDER BY watched DESC, position ASC, name ASC';

    listRepos(): RepoRecord[] {
        return this.db
            .query<RepoRow, []>(`SELECT * FROM repos ${WatchStore.ORDER}`)
            .all()
            .map(WatchStore.toRecord);
    }

    /** Repos belonging to one instance; project ids are meaningless across hosts. */
    listReposFor(baseUrl: string): RepoRecord[] {
        return this.db
            .query<RepoRow, [string]>(`SELECT * FROM repos WHERE base_url = ? ${WatchStore.ORDER}`)
            .all(baseUrl)
            .map(WatchStore.toRecord);
    }

    setWatched(name: string, watched: boolean): boolean {
        return (
            this.db.query('UPDATE repos SET watched = ? WHERE name = ?').run(watched ? 1 : 0, name).changes > 0
        );
    }

    countFor(baseUrl: string): number {
        return (
            this.db
                .query<{ total: number }, [string]>('SELECT COUNT(*) AS total FROM repos WHERE base_url = ?')
                .get(baseUrl)?.total ?? 0
        );
    }

    getRepo(name: string): RepoRecord | undefined {
        const row = this.db.query<RepoRow, [string]>('SELECT * FROM repos WHERE name = ?').get(name);
        return row ? WatchStore.toRecord(row) : undefined;
    }

    has(name: string): boolean {
        return this.getRepo(name) !== undefined;
    }

    get count(): number {
        return this.db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM repos').get()?.total ?? 0;
    }

    addRepo(repo: NewRepo): RepoRecord {
        if (this.has(repo.name)) throw new Error(`${repo.name} is already on the watch list`);

        const nextPosition = (this.db
            .query<{ next: number | null }, []>('SELECT MAX(position) AS next FROM repos')
            .get()?.next ?? 0) + 1;

        this.db
            .query(
                `INSERT INTO repos (name, project_id, path, ref, grp, position, added_at, base_url, web_url, watched)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                repo.name,
                repo.projectId,
                repo.path ?? null,
                repo.ref?.trim() || this.settings.defaultRef,
                repo.group?.trim() || 'watched',
                nextPosition,
                new Date().toISOString(),
                repo.baseUrl?.trim() || this.settings.activeBaseUrl || '',
                repo.webUrl ?? null,
                repo.watched === false ? 0 : 1,
            );

        return this.getRepo(repo.name)!;
    }

    removeRepo(name: string): boolean {
        return this.db.query('DELETE FROM repos WHERE name = ?').run(name).changes > 0;
    }

    // --- credentials ---

    private static toCredential(row: CredentialRow): CredentialRecord {
        return {
            baseUrl: row.base_url,
            tokenKind: row.token_kind as SecretKind,
            tokenRef: row.token_ref,
            username: row.username,
            validatedAt: row.validated_at,
        };
    }

    getCredential(baseUrl: string): CredentialRecord | undefined {
        const row = this.db
            .query<CredentialRow, [string]>('SELECT * FROM credentials WHERE base_url = ?')
            .get(baseUrl);
        return row ? WatchStore.toCredential(row) : undefined;
    }

    saveCredential(baseUrl: string, secret: StoredSecret, username: string | null): CredentialRecord {
        this.db
            .query(
                `INSERT INTO credentials (base_url, token_kind, token_ref, username, validated_at, created_at)
                 VALUES (?, ?, ?, ?, ?, ?)
                 ON CONFLICT(base_url) DO UPDATE SET
                    token_kind = excluded.token_kind,
                    token_ref = excluded.token_ref,
                    username = excluded.username,
                    validated_at = excluded.validated_at`,
            )
            .run(baseUrl, secret.kind, secret.ref, username, new Date().toISOString(), new Date().toISOString());

        return this.getCredential(baseUrl)!;
    }

    deleteCredential(baseUrl: string): boolean {
        return this.db.query('DELETE FROM credentials WHERE base_url = ?').run(baseUrl).changes > 0;
    }

    // --- tags ---

    /** Every tag on an instance with its membership count, in creation order. */
    listTags(baseUrl: string): TagRecord[] {
        return this.db
            .query<{ name: string; count: number }, [string]>(
                `SELECT t.name AS name, COUNT(rt.repo_name) AS count
                 FROM tags t
                 LEFT JOIN repo_tags rt ON rt.tag_name = t.name AND rt.base_url = t.base_url
                 WHERE t.base_url = ?
                 GROUP BY t.name
                 ORDER BY t.position ASC, t.name ASC`,
            )
            .all(baseUrl)
            .map((row) => ({ name: row.name, count: row.count }));
    }

    /** Memberships for a whole instance in one query, keyed by repo name. */
    tagsByRepo(baseUrl: string): Map<string, string[]> {
        const rows = this.db
            .query<{ repo_name: string; tag_name: string }, [string]>(
                `SELECT rt.repo_name, rt.tag_name
                 FROM repo_tags rt
                 JOIN tags t ON t.name = rt.tag_name AND t.base_url = rt.base_url
                 WHERE rt.base_url = ?
                 ORDER BY t.position ASC, t.name ASC`,
            )
            .all(baseUrl);

        const byRepo = new Map<string, string[]>();
        for (const row of rows) {
            const list = byRepo.get(row.repo_name);
            if (list) list.push(row.tag_name);
            else byRepo.set(row.repo_name, [row.tag_name]);
        }
        return byRepo;
    }

    hasTag(baseUrl: string, name: string): boolean {
        return this.db
            .query<{ n: number }, [string, string]>('SELECT COUNT(*) AS n FROM tags WHERE base_url = ? AND name = ?')
            .get(baseUrl, name)!.n > 0;
    }

    /** Creating an existing tag is a no-op, so import never has to check first. */
    createTag(baseUrl: string, name: string): string {
        const tag = name.trim();
        if (!tag) throw new Error('A tag needs a name');

        const next = (this.db
            .query<{ next: number | null }, [string]>('SELECT MAX(position) AS next FROM tags WHERE base_url = ?')
            .get(baseUrl)?.next ?? 0) + 1;

        this.db
            .query(
                `INSERT INTO tags (name, base_url, position, created_at) VALUES (?, ?, ?, ?)
                 ON CONFLICT(name, base_url) DO NOTHING`,
            )
            .run(tag, baseUrl, next, new Date().toISOString());

        return tag;
    }

    renameTag(baseUrl: string, from: string, to: string): boolean {
        const target = to.trim();
        if (!target || !this.hasTag(baseUrl, from)) return false;
        if (target !== from && this.hasTag(baseUrl, target)) {
            throw new Error(`${target} already exists`);
        }

        // `ON UPDATE CASCADE` moves the memberships with the name.
        this.db.query('UPDATE tags SET name = ? WHERE base_url = ? AND name = ?').run(target, baseUrl, from);
        return true;
    }

    deleteTag(baseUrl: string, name: string): boolean {
        return this.db.query('DELETE FROM tags WHERE base_url = ? AND name = ?').run(baseUrl, name).changes > 0;
    }

    /** Replaces a repo's tags outright; unknown tags are created on the way. */
    setRepoTags(baseUrl: string, repoName: string, tags: string[]): string[] {
        const wanted = normaliseTags(tags);

        this.db.transaction(() => {
            for (const tag of wanted) this.createTag(baseUrl, tag);
            this.db.query('DELETE FROM repo_tags WHERE base_url = ? AND repo_name = ?').run(baseUrl, repoName);
            for (const tag of wanted) {
                this.db
                    .query('INSERT INTO repo_tags (repo_name, tag_name, base_url) VALUES (?, ?, ?)')
                    .run(repoName, tag, baseUrl);
            }
        })();

        return wanted;
    }

    /** The bulk direction: set one tag's whole membership in a single call. */
    setTagRepos(baseUrl: string, tag: string, repoNames: string[]): string[] {
        if (!this.hasTag(baseUrl, tag)) throw new Error(`${tag} is not a tag`);

        const onBoard = new Set(this.listReposFor(baseUrl).map((repo) => repo.name));
        const wanted = [...new Set(repoNames)].filter((name) => onBoard.has(name));

        this.db.transaction(() => {
            this.db.query('DELETE FROM repo_tags WHERE base_url = ? AND tag_name = ?').run(baseUrl, tag);
            for (const name of wanted) {
                this.db
                    .query('INSERT INTO repo_tags (repo_name, tag_name, base_url) VALUES (?, ?, ?)')
                    .run(name, tag, baseUrl);
            }
        })();

        return wanted;
    }

    /** Adds without removing — how an import merges into a repo already watched. */
    addRepoTags(baseUrl: string, repoName: string, tags: string[]): string[] {
        const existing = this.tagsByRepo(baseUrl).get(repoName) ?? [];
        return this.setRepoTags(baseUrl, repoName, [...existing, ...normaliseTags(tags)]);
    }

    // --- sharing ---

    /**
     * Credentials are deliberately absent: an export is meant to be shared.
     *
     * The instance is a parameter rather than `settings.activeBaseUrl`, because
     * that setting is only written when credentials are saved through the UI —
     * a board configured from `GITLAB_BASE_URL` never sets it, and the tags would
     * silently come back empty.
     */
    exportList(baseUrl: string): ExportFile {
        const { pollPeriodSeconds, defaultRef } = this.settings;
        const tagsByRepo = this.tagsByRepo(baseUrl);

        return {
            version: EXPORT_VERSION,
            exportedAt: new Date().toISOString(),
            settings: { pollPeriodSeconds, defaultRef },
            // Listed whole, so a tag nothing carries yet still travels.
            tags: this.listTags(baseUrl).map((tag) => tag.name),
            repos: this.listRepos().map((repo) => ({
                name: repo.name,
                projectId: repo.projectId,
                path: repo.path,
                ref: repo.ref,
                group: repo.group,
                baseUrl: repo.baseUrl,
                watched: repo.watched,
                tags: tagsByRepo.get(repo.name) ?? [],
            })),
        };
    }
}
