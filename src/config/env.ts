import { existsSync, readFileSync } from 'node:fs';

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/;

export class EnvError extends Error { }

export function parseEnvFile(content: string): Record<string, string> {
    const values: Record<string, string> = {};

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const match = LINE.exec(line);
        if (!match) continue;

        const [, key, rawValue = ''] = match;
        let value = rawValue.trim();

        const quote = value[0];
        if ((quote === "'" || quote === '"') && value.endsWith(quote) && value.length > 1) {
            value = value.slice(1, -1);
        } else {
            const hash = value.indexOf(' #');
            if (hash !== -1) value = value.slice(0, hash).trim();
        }

        values[key!] = value;
    }

    return values;
}

export interface LoadEnvResult {
    loaded: boolean;
    path: string;
    values: Record<string, string>;
}

/** Reads an env file without touching `process.env`. */
export function readEnvFile(path: string): LoadEnvResult {
    if (!existsSync(path)) return { loaded: false, path, values: {} };
    return { loaded: true, path, values: parseEnvFile(readFileSync(path, 'utf-8')) };
}

/**
 * Variables read back off `process.env` later, and the only ones an env file is
 * allowed to export into it.
 *
 * Credentials are deliberately absent. They are resolved from the layers, never
 * from `process.env`, so exporting them buys nothing and costs the token being
 * readable in `/proc/<pid>/environ` and inherited by every child process — the
 * credential-store helpers among them.
 */
const EXPORTED_KEYS = ['CI_DECK_PORT', 'CI_DECK_DB', 'CI_DECK_TAGS'] as const;

/** Names a file may set that this process must not carry in its environment. */
const SECRET_KEYS = ['GITLAB_PAT'] as const;

/** Exports file values for anything not already set, leaving inline values alone. */
export function applyEnvValues(values: Record<string, string>): void {
    for (const key of EXPORTED_KEYS) {
        const value = values[key];
        if (value === undefined) continue;
        if (process.env[key] === undefined || process.env[key] === '') process.env[key] = value;
    }
}

/**
 * Drops the token from the environment once it has been captured.
 *
 * Bun applies `./.env` to the process before any of our code runs, so declining
 * to export it ourselves is not enough — by then it is already there. Call this
 * after the layers are read, and the value survives only in the layer that
 * resolution actually uses.
 */
export function scrubSecretEnv(env: NodeJS.ProcessEnv = process.env): void {
    for (const key of SECRET_KEYS) delete env[key];
}

/**
 * Variables whose value no env file accounts for, i.e. genuinely inline ones.
 *
 * Bun loads `./.env` into the process itself before any of our code runs, so a
 * file value is otherwise indistinguishable from `GITLAB_PAT=… ci-deck`. Values
 * a file explains are attributed to that file; the rest are inline.
 */
export function unexplainedByFiles(
    env: NodeJS.ProcessEnv,
    fileValues: Record<string, string>,
): Record<string, string | undefined> {
    const inline: Record<string, string | undefined> = {};

    for (const [key, value] of Object.entries(env)) {
        if (value === undefined) continue;
        if (fileValues[key] !== undefined && fileValues[key] === value) continue;
        inline[key] = value;
    }

    return inline;
}

/** Throws when the token could not possibly be a GitLab token. */
export function validateToken(token: string): string {
    const trimmed = token.trim();

    if (!trimmed) throw new EnvError('The token is empty');
    if (!/^[\w.~-]+$/.test(trimmed)) {
        throw new EnvError(
            'That token contains characters a GitLab token never has. Check for stray quotes or spaces.',
        );
    }
    return trimmed;
}

/** Normalises an instance URL to a form the API client can build on. */
export function normaliseBaseUrl(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) throw new EnvError('The GitLab URL is empty');

    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        throw new EnvError(`Not a valid URL: ${trimmed}`);
    }

    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new EnvError(`The GitLab URL must be http or https, got ${url.protocol}`);
    }

    if (url.search || url.hash) {
        throw new EnvError('The GitLab URL must not carry a query or fragment');
    }

    // A pasted project page is a common mistake; /-/ never appears in an instance root.
    if (url.pathname.includes('/-/')) {
        throw new EnvError(
            `That looks like a project page, not an instance root. Use just the scheme and host, e.g. ${url.origin}/`,
        );
    }

    return url.pathname.endsWith('/') ? url.toString() : `${url.toString()}/`;
}

export function readOptionalPort(): number | null {
    const raw = process.env.CI_DECK_PORT?.trim();
    if (!raw) return null;

    const port = Number.parseInt(raw, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new EnvError(`CI_DECK_PORT is not a valid port: ${raw}`);
    }
    return port;
}

export function readOptionalDbPath(): string | null {
    return process.env.CI_DECK_DB?.trim() || null;
}

/**
 * Tags are stored, served and exported regardless; this only decides whether the
 * board offers them. The data model is settled, the interface is not, so it ships
 * dark and can be turned on to work on it against a real watch list.
 */
export function tagsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.CI_DECK_TAGS?.trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'on';
}
