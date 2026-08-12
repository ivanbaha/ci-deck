import { Database } from 'bun:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SecretKind, StoredSecret } from '../config/secrets.ts';
import {
    COLUMN_KEYS,
    DEFAULT_COLUMN_WIDTHS,
    MAX_COLUMN_WIDTH,
    MIN_COLUMN_WIDTH,
    type ColumnKey,
    type NotifyMode,
    type ThemePreference,
} from '../shared/types.ts';
import { EXPORT_VERSION, type ExportFile, normaliseTags } from '../shared/watchlist.ts';

// The format itself lives in shared/ so the browser can parse a file the same
// way; re-exported here because that is where callers already look for it.
export { EXPORT_VERSION, normaliseTags, parseExportFile, parseExportSettings, parseExportTags } from '../shared/watchlist.ts';
export type { ExportedRepo, ExportFile } from '../shared/watchlist.ts';

/** The database could not be opened — which is fatal, and rarely SQLite's fault. */
export class StoreError extends Error { }

export interface RepoRecord {
    /** Surrogate key. A repo watched on two branches is two rows sharing a name. */
    id: number;
    name: string;
    projectId: number;
    path: string | null;
    ref: string;
    group: string;
    position: number;
    /** GitLab instance this repo was resolved against. */
    baseUrl: string;
    /** False keeps the repo on the board but out of the periodic sweep. */
    watched: boolean;
    notify: NotifyMode;
    /** The branch is gone from GitLab; the row stays so it can be cleared out. */
    branchMissing: boolean;
}

export interface NewRepo {
    name: string;
    projectId: number;
    path?: string | null;
    ref?: string;
    group?: string;
    baseUrl?: string;
    watched?: boolean;
    notify?: NotifyMode;
}

export interface StoreSettings {
    pollPeriodSeconds: number;
    defaultRef: string;
    retries: number;
    /** Instance the board is currently pointed at, when one has been configured. */
    activeBaseUrl: string | null;
    confirmManualRun: boolean;
    /** Global switch over every row's own setting. */
    notifications: NotifyMode;
    theme: ThemePreference;
    columnWidths: Record<ColumnKey, number>;
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
    confirmManualRun: true,
    notifications: 'on',
    theme: 'system',
    columnWidths: { ...DEFAULT_COLUMN_WIDTHS },
};

export const MIN_POLL_SECONDS = 10;
export const MAX_POLL_SECONDS = 3_600;

const NOTIFY_MODES = new Set<string>(['on', 'snooze', 'off']);
const THEMES = new Set<string>(['system', 'dark', 'light']);

export function isNotifyMode(value: unknown): value is NotifyMode {
    return typeof value === 'string' && NOTIFY_MODES.has(value);
}

export function isThemePreference(value: unknown): value is ThemePreference {
    return typeof value === 'string' && THEMES.has(value);
}

export function clampPollPeriod(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), MIN_POLL_SECONDS), MAX_POLL_SECONDS);
}

export function clampColumnWidth(value: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.min(Math.max(Math.round(value), MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH);
}

/** A stored settings value that should be a JSON object of column widths. */
function parseStoredWidths(raw: string | undefined): Record<ColumnKey, number> {
    const widths = { ...DEFAULT_COLUMN_WIDTHS };
    if (!raw) return widths;

    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const key of COLUMN_KEYS) {
            const value = parsed?.[key];
            if (typeof value === 'number') widths[key] = clampColumnWidth(value, widths[key]);
        }
    } catch {
        // A value nobody can parse is a value nobody set.
    }
    return widths;
}

interface RepoRow {
    id: number;
    name: string;
    project_id: number;
    path: string | null;
    ref: string;
    grp: string;
    position: number;
    base_url: string;
    watched: number;
    notify: string;
    branch_missing: number;
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

    // A surrogate key, because a name stopped identifying a row: the same repo can
    // now be watched on several branches, and a name was never unique across
    // instances either — two boards pointed at different hosts would collide on it.
    //
    // SQLite cannot change a primary key in place, so both tables are rebuilt and
    // renamed into position. `repo_tags_new` is declared against `repos` — the name
    // the new table will have, not the one it has while this runs — because a
    // rename only rewrites other tables' REFERENCES clauses when foreign keys are
    // enabled, and they cannot be: dropping a table another still references is
    // exactly what this migration has to do.
    `CREATE TABLE repos_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        project_id INTEGER NOT NULL,
        path TEXT,
        ref TEXT NOT NULL,
        grp TEXT NOT NULL DEFAULT 'watched',
        position INTEGER NOT NULL,
        added_at TEXT NOT NULL,
        base_url TEXT NOT NULL DEFAULT '',
        web_url TEXT,
        watched INTEGER NOT NULL DEFAULT 1,
        notify TEXT NOT NULL DEFAULT 'on',
        branch_missing INTEGER NOT NULL DEFAULT 0
    );
    INSERT INTO repos_new (name, project_id, path, ref, grp, position, added_at, base_url, web_url, watched)
        SELECT name, project_id, path, ref, grp, position, added_at, base_url, web_url, watched FROM repos;

    CREATE TABLE repo_tags_new (
        repo_id INTEGER NOT NULL,
        tag_name TEXT NOT NULL,
        base_url TEXT NOT NULL,
        PRIMARY KEY (repo_id, tag_name),
        FOREIGN KEY (repo_id) REFERENCES repos (id) ON DELETE CASCADE,
        FOREIGN KEY (tag_name, base_url) REFERENCES tags (name, base_url)
            ON DELETE CASCADE ON UPDATE CASCADE
    );
    INSERT INTO repo_tags_new (repo_id, tag_name, base_url)
        SELECT r.id, rt.tag_name, rt.base_url
        FROM repo_tags rt
        JOIN repos_new r ON r.name = rt.repo_name AND r.base_url = rt.base_url;

    DROP TABLE repo_tags;
    DROP TABLE repos;
    ALTER TABLE repos_new RENAME TO repos;
    ALTER TABLE repo_tags_new RENAME TO repo_tags;

    CREATE UNIQUE INDEX repos_identity ON repos (base_url, name, ref);
    CREATE INDEX repos_position ON repos (position);
    CREATE INDEX repo_tags_tag ON repo_tags (base_url, tag_name);

    -- The tag filter lives in the URL now, and the sweep covers every watched repo
    -- regardless of it, so neither of these has a reader left.
    DELETE FROM settings WHERE key IN ('activeTags', 'scopeSweepToTags');`,
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
        this.migrate();
        // After the migration rather than before it: rebuilding a table means
        // dropping one that another still references, which the constraint refuses.
        // An in-memory store turns it on here too, so tests see tag memberships
        // cascade exactly as they do on disk.
        this.db.exec('PRAGMA foreign_keys = ON;');
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
        if (current >= MIGRATIONS.length) return;

        this.db.exec('PRAGMA foreign_keys = OFF;');
        for (let version = current; version < MIGRATIONS.length; version += 1) {
            this.db.exec(MIGRATIONS[version]!);
        }
        this.db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
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

        const flag = (key: keyof StoreSettings, fallback: boolean) => {
            const raw = stored.get(key);
            return raw === undefined ? fallback : raw === '1';
        };

        const notifications = stored.get('notifications');
        const theme = stored.get('theme');

        return {
            pollPeriodSeconds: clampPollPeriod(
                number('pollPeriodSeconds', DEFAULT_SETTINGS.pollPeriodSeconds),
                DEFAULT_SETTINGS.pollPeriodSeconds,
            ),
            defaultRef: stored.get('defaultRef')?.trim() || DEFAULT_SETTINGS.defaultRef,
            retries: number('retries', DEFAULT_SETTINGS.retries),
            activeBaseUrl: stored.get('activeBaseUrl')?.trim() || null,
            confirmManualRun: flag('confirmManualRun', DEFAULT_SETTINGS.confirmManualRun),
            notifications: isNotifyMode(notifications) ? notifications : DEFAULT_SETTINGS.notifications,
            theme: isThemePreference(theme) ? theme : DEFAULT_SETTINGS.theme,
            columnWidths: parseStoredWidths(stored.get('columnWidths')),
        };
    }

    setActiveBaseUrl(baseUrl: string): void {
        this.putSetting('activeBaseUrl', baseUrl);
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

    setConfirmManualRun(confirm: boolean): boolean {
        this.putSetting('confirmManualRun', confirm ? '1' : '0');
        return confirm;
    }

    setNotifications(mode: NotifyMode): NotifyMode {
        this.putSetting('notifications', mode);
        return mode;
    }

    setTheme(theme: ThemePreference): ThemePreference {
        this.putSetting('theme', theme);
        return theme;
    }

    /** Merges over what is stored, so one dragged column need not send the rest. */
    setColumnWidths(widths: Partial<Record<ColumnKey, number>>): Record<ColumnKey, number> {
        const merged = { ...this.settings.columnWidths };
        for (const key of COLUMN_KEYS) {
            const value = widths[key];
            if (typeof value === 'number') merged[key] = clampColumnWidth(value, merged[key]);
        }
        this.putSetting('columnWidths', JSON.stringify(merged));
        return merged;
    }

    // --- repos ---

    private static toRecord(row: RepoRow): RepoRecord {
        return {
            id: row.id,
            name: row.name,
            projectId: row.project_id,
            path: row.path,
            ref: row.ref,
            group: row.grp,
            position: row.position,
            baseUrl: row.base_url,
            watched: row.watched === 1,
            notify: isNotifyMode(row.notify) ? row.notify : 'on',
            branchMissing: row.branch_missing === 1,
        };
    }

    /**
     * Watched repos first, so paused ones collect at the bottom; then by name and
     * ref, which is what keeps two branches of one repo side by side rather than
     * wherever in the list they each happened to be added.
     */
    private static readonly ORDER = 'ORDER BY watched DESC, name ASC, ref ASC, position ASC';

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

    setWatched(id: number, watched: boolean): boolean {
        return this.db.query('UPDATE repos SET watched = ? WHERE id = ?').run(watched ? 1 : 0, id).changes > 0;
    }

    setNotify(id: number, mode: NotifyMode): boolean {
        return this.db.query('UPDATE repos SET notify = ? WHERE id = ?').run(mode, id).changes > 0;
    }

    setBranchMissing(id: number, missing: boolean): boolean {
        return this.db.query('UPDATE repos SET branch_missing = ? WHERE id = ?').run(missing ? 1 : 0, id).changes > 0;
    }

    countFor(baseUrl: string): number {
        return (
            this.db
                .query<{ total: number }, [string]>('SELECT COUNT(*) AS total FROM repos WHERE base_url = ?')
                .get(baseUrl)?.total ?? 0
        );
    }

    getRepo(id: number): RepoRecord | undefined {
        const row = this.db.query<RepoRow, [number]>('SELECT * FROM repos WHERE id = ?').get(id);
        return row ? WatchStore.toRecord(row) : undefined;
    }

    /** The identity a watch list is keyed by: one instance, one repo, one branch. */
    findRepo(baseUrl: string, name: string, ref: string): RepoRecord | undefined {
        const row = this.db
            .query<RepoRow, [string, string, string]>(
                'SELECT * FROM repos WHERE base_url = ? AND name = ? AND ref = ?',
            )
            .get(baseUrl, name, ref);
        return row ? WatchStore.toRecord(row) : undefined;
    }

    /** Every branch of one project already on the board. */
    refsFor(baseUrl: string, projectId: number): string[] {
        return this.db
            .query<{ ref: string }, [string, number]>(
                'SELECT ref FROM repos WHERE base_url = ? AND project_id = ? ORDER BY ref ASC',
            )
            .all(baseUrl, projectId)
            .map((row) => row.ref);
    }

    get count(): number {
        return this.db.query<{ total: number }, []>('SELECT COUNT(*) AS total FROM repos').get()?.total ?? 0;
    }

    addRepo(repo: NewRepo): RepoRecord {
        const baseUrl = repo.baseUrl?.trim() || this.settings.activeBaseUrl || '';
        const ref = repo.ref?.trim() || this.settings.defaultRef;

        if (this.findRepo(baseUrl, repo.name, ref)) {
            throw new Error(`${repo.name} is already watched on ${ref}`);
        }

        const nextPosition = (this.db
            .query<{ next: number | null }, []>('SELECT MAX(position) AS next FROM repos')
            .get()?.next ?? 0) + 1;

        // `web_url` is left to its default: a project's URL is derived from its path
        // and the instance it belongs to, which cannot go stale the way a copy would.
        const { lastInsertRowid } = this.db
            .query(
                `INSERT INTO repos (name, project_id, path, ref, grp, position, added_at, base_url, watched, notify)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
                repo.name,
                repo.projectId,
                repo.path ?? null,
                ref,
                repo.group?.trim() || 'watched',
                nextPosition,
                new Date().toISOString(),
                baseUrl,
                repo.watched === false ? 0 : 1,
                repo.notify ?? 'on',
            );

        return this.getRepo(Number(lastInsertRowid))!;
    }

    removeRepo(id: number): boolean {
        return this.db.query('DELETE FROM repos WHERE id = ?').run(id).changes > 0;
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
                `SELECT t.name AS name, COUNT(rt.repo_id) AS count
                 FROM tags t
                 LEFT JOIN repo_tags rt ON rt.tag_name = t.name AND rt.base_url = t.base_url
                 WHERE t.base_url = ?
                 GROUP BY t.name
                 ORDER BY t.position ASC, t.name ASC`,
            )
            .all(baseUrl)
            .map((row) => ({ name: row.name, count: row.count }));
    }

    /** Memberships for a whole instance in one query, keyed by repo id. */
    tagsByRepo(baseUrl: string): Map<number, string[]> {
        const rows = this.db
            .query<{ repo_id: number; tag_name: string }, [string]>(
                `SELECT rt.repo_id, rt.tag_name
                 FROM repo_tags rt
                 JOIN tags t ON t.name = rt.tag_name AND t.base_url = rt.base_url
                 WHERE rt.base_url = ?
                 ORDER BY t.position ASC, t.name ASC`,
            )
            .all(baseUrl);

        const byRepo = new Map<number, string[]>();
        for (const row of rows) {
            const list = byRepo.get(row.repo_id);
            if (list) list.push(row.tag_name);
            else byRepo.set(row.repo_id, [row.tag_name]);
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
    setRepoTags(baseUrl: string, repoId: number, tags: string[]): string[] {
        const wanted = normaliseTags(tags);

        this.db.transaction(() => {
            for (const tag of wanted) this.createTag(baseUrl, tag);
            this.db.query('DELETE FROM repo_tags WHERE base_url = ? AND repo_id = ?').run(baseUrl, repoId);
            for (const tag of wanted) {
                this.db
                    .query('INSERT INTO repo_tags (repo_id, tag_name, base_url) VALUES (?, ?, ?)')
                    .run(repoId, tag, baseUrl);
            }
        })();

        return wanted;
    }

    /** The bulk direction: set one tag's whole membership in a single call. */
    setTagRepos(baseUrl: string, tag: string, repoIds: number[]): number[] {
        if (!this.hasTag(baseUrl, tag)) throw new Error(`${tag} is not a tag`);

        const onBoard = new Set(this.listReposFor(baseUrl).map((repo) => repo.id));
        const wanted = [...new Set(repoIds)].filter((id) => onBoard.has(id));

        this.db.transaction(() => {
            this.db.query('DELETE FROM repo_tags WHERE base_url = ? AND tag_name = ?').run(baseUrl, tag);
            for (const id of wanted) {
                this.db
                    .query('INSERT INTO repo_tags (repo_id, tag_name, base_url) VALUES (?, ?, ?)')
                    .run(id, tag, baseUrl);
            }
        })();

        return wanted;
    }

    /** Adds without removing — how an import merges into a repo already watched. */
    addRepoTags(baseUrl: string, repoId: number, tags: string[]): string[] {
        const existing = this.tagsByRepo(baseUrl).get(repoId) ?? [];
        return this.setRepoTags(baseUrl, repoId, [...existing, ...normaliseTags(tags)]);
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
            // Scoped like everything else here: an export is meant to be shared, and
            // the rows of an instance this board is not pointed at — an internal host
            // and its project paths — are nobody else's business.
            repos: this.listReposFor(baseUrl).map((repo) => ({
                name: repo.name,
                projectId: repo.projectId,
                path: repo.path,
                ref: repo.ref,
                group: repo.group,
                baseUrl: repo.baseUrl,
                watched: repo.watched,
                notify: repo.notify,
                tags: tagsByRepo.get(repo.id) ?? [],
            })),
        };
    }
}
