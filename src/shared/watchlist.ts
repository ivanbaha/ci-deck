/**
 * The watch-list file format, kept free of any Bun or SQLite import so both the
 * server and the browser can use it. The import dialog previews a file with the
 * very same parser the server will run on it, which is the only way the preview
 * and the result cannot drift apart.
 */

/**
 * 2 added tags; 3 added the notification setting, and made a repo's identity
 * name-plus-branch rather than name alone; 4 gave a tag a description and a
 * colour, so the top-level list holds objects rather than bare names.
 *
 * Older files still import. A version 3 list of names reads as tags with
 * neither field set, and a branch missing from a version 2 file falls back to
 * the board's default, which is what those files always meant.
 */
export const EXPORT_VERSION = 4;

export interface ExportedRepo {
    name: string;
    projectId?: number;
    path?: string | null;
    /** Part of the identity: the same repo may appear once per branch watched. */
    ref?: string;
    group?: string;
    /** Instance the id was resolved against; ids do not transfer between hosts. */
    baseUrl?: string;
    watched?: boolean;
    notify?: string;
    tags?: string[];
}

/**
 * A tag as a file carries it. Only the name is required — a hand-written file
 * may list bare names, and a version 3 export always did.
 */
export interface ExportedTag {
    name: string;
    description?: string;
    color?: string;
}

export interface ExportFile {
    version: number;
    exportedAt: string;
    settings: { pollPeriodSeconds: number; defaultRef: string };
    /** Every tag on the board, so empty ones survive a round trip. */
    tags: ExportedTag[];
    repos: ExportedRepo[];
}

/** Trimmed, de-duplicated, order preserved. Empty strings are not tags. */
export function normaliseTags(raw: unknown): string[] {
    if (!Array.isArray(raw)) return [];

    const seen = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const tag = entry.trim();
        if (tag) seen.add(tag);
    }
    return [...seen];
}

/**
 * Reads a watch list produced by the export endpoint, and tolerates hand-written
 * files: entries may be bare strings or omit everything but a name or path.
 */
export function parseExportFile(raw: unknown): ExportedRepo[] {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const entries = Array.isArray(source.repos) ? source.repos : Array.isArray(raw) ? raw : [];
    const repos: ExportedRepo[] = [];

    for (const entry of entries) {
        if (typeof entry === 'string') {
            const name = entry.trim();
            if (name) repos.push({ name });
            continue;
        }
        if (!entry || typeof entry !== 'object') continue;

        const candidate = entry as Record<string, unknown>;
        const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
        const path = typeof candidate.path === 'string' ? candidate.path.trim() : '';
        if (!name && !path) continue;

        repos.push({
            name: name || path,
            ...(path ? { path } : {}),
            ...(typeof candidate.projectId === 'number' && Number.isInteger(candidate.projectId)
                ? { projectId: candidate.projectId }
                : {}),
            ...(typeof candidate.ref === 'string' && candidate.ref.trim() ? { ref: candidate.ref.trim() } : {}),
            ...(typeof candidate.group === 'string' && candidate.group.trim()
                ? { group: candidate.group.trim() }
                : {}),
            ...(typeof candidate.baseUrl === 'string' && candidate.baseUrl.trim()
                ? { baseUrl: candidate.baseUrl.trim() }
                : {}),
            ...(typeof candidate.watched === 'boolean' ? { watched: candidate.watched } : {}),
            ...(candidate.notify === 'on' || candidate.notify === 'snooze' || candidate.notify === 'off'
                ? { notify: candidate.notify }
                : {}),
            ...(Array.isArray(candidate.tags) ? { tags: normaliseTags(candidate.tags) } : {}),
        });
    }

    return repos;
}

/**
 * The settings a file carries, which an import applies. Both are optional and
 * neither is trusted to be the right type — the poll period is clamped where it
 * is stored, the same as one typed into the board.
 *
 * Shared for the same reason the repo parser is: the import dialog says what a
 * file would change before it changes it, and it must read the file the way the
 * server will.
 */
export function parseExportSettings(raw: unknown): Partial<ExportFile['settings']> {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const settings = (source.settings && typeof source.settings === 'object' ? source.settings : {}) as Record<string, unknown>;
    const ref = typeof settings.defaultRef === 'string' ? settings.defaultRef.trim() : '';

    return {
        ...(typeof settings.pollPeriodSeconds === 'number' && Number.isFinite(settings.pollPeriodSeconds)
            ? { pollPeriodSeconds: settings.pollPeriodSeconds }
            : {}),
        ...(ref ? { defaultRef: ref } : {}),
    };
}

/** Six hex digits or nothing: a colour the board cannot draw is not a colour. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/**
 * One entry of the top-level tag list. A string is a name and nothing else,
 * which is what version 3 files and hand-written ones carry.
 */
function parseExportTag(raw: unknown): ExportedTag | null {
    if (typeof raw === 'string') {
        const name = raw.trim();
        return name ? { name } : null;
    }
    if (!raw || typeof raw !== 'object') return null;

    const candidate = raw as Record<string, unknown>;
    const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
    if (!name) return null;

    const description = typeof candidate.description === 'string' ? candidate.description.trim() : '';
    const color = typeof candidate.color === 'string' ? candidate.color.trim().toLowerCase() : '';

    return {
        name,
        ...(description ? { description } : {}),
        ...(HEX_COLOR.test(color) ? { color } : {}),
    };
}

/**
 * Every tag the file mentions: the top-level list plus anything only a repo
 * names, so a hand-written file need not declare its tags up front.
 *
 * The declared entry wins over a mention, since only the declaration can carry
 * a description or a colour — and the first of two declarations of one name
 * wins over the second, the same way the repo list keeps its first entry.
 */
export function parseExportTags(raw: unknown): ExportedTag[] {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const declared = Array.isArray(source.tags) ? source.tags : [];
    const mentioned = parseExportFile(raw).flatMap((repo) => repo.tags ?? []);

    const byName = new Map<string, ExportedTag>();
    for (const entry of [...declared, ...mentioned]) {
        const tag = parseExportTag(entry);
        if (tag && !byName.has(tag.name)) byName.set(tag.name, tag);
    }
    return [...byName.values()];
}
