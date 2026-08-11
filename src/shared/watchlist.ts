/**
 * The watch-list file format, kept free of any Bun or SQLite import so both the
 * server and the browser can use it. The import dialog previews a file with the
 * very same parser the server will run on it, which is the only way the preview
 * and the result cannot drift apart.
 */

/** 2 added tags. Version 1 files still import; they simply carry none. */
export const EXPORT_VERSION = 2;

export interface ExportedRepo {
    name: string;
    projectId?: number;
    path?: string | null;
    ref?: string;
    group?: string;
    /** Instance the id was resolved against; ids do not transfer between hosts. */
    baseUrl?: string;
    watched?: boolean;
    tags?: string[];
}

export interface ExportFile {
    version: number;
    exportedAt: string;
    settings: { pollPeriodSeconds: number; defaultRef: string };
    /** Every tag on the board, so empty ones survive a round trip. */
    tags: string[];
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

/**
 * Every tag the file mentions: the top-level list plus anything only a repo
 * names, so a hand-written file need not declare its tags up front.
 */
export function parseExportTags(raw: unknown): string[] {
    const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const fromRepos = parseExportFile(raw).flatMap((repo) => repo.tags ?? []);
    return normaliseTags([...normaliseTags(source.tags), ...fromRepos]);
}
