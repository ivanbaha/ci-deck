import type { BunFile } from 'bun';
import { resolve } from 'node:path';

/**
 * Where the board's own files come from. A checkout and an installed package
 * both read a built `public/`; a standalone binary carries the same files
 * inside itself, so the server asks for them by name rather than by path.
 */
export interface Assets {
    /** The app shell, served for `/` and for anything that is not an API path. */
    index(): BunFile;
    /** A file under `/assets`, or null when there is no such asset. */
    asset(name: string): Promise<BunFile | null>;
}

/** `main.js`, `main.js.map`, `app.css` — a bare `.` or `..` is not a name. */
const ASSET_NAME = /^[\w-]+(?:\.[\w-]+)+$/;

/** Reads from a `public/` directory built by `buildWeb`. */
export function directoryAssets(publicDir: string): Assets {
    return {
        index: () => Bun.file(resolve(publicDir, 'index.html')),

        async asset(name) {
            if (!ASSET_NAME.test(name)) return null;

            // Bun turns a missing or non-regular file into a 500 with the
            // absolute path in it; a 404 is both truer and quieter.
            const file = Bun.file(resolve(publicDir, 'assets', name));
            return (await file.exists()) ? file : null;
        },
    };
}

/**
 * Reads from files compiled into the executable. Bun rewrites each embedded
 * import to a path inside the binary — extension intact, which is what lets
 * `Bun.file` keep answering with the right content type.
 */
export function embeddedAssets(index: string, assets: Record<string, string>): Assets {
    // A Map rather than the object itself: `/assets/__proto__` would otherwise
    // find Object.prototype and hand something that is not a path to Bun.file.
    const files = new Map(Object.entries(assets));

    return {
        index: () => Bun.file(index),

        async asset(name) {
            const path = files.get(name);
            return path ? Bun.file(path) : null;
        },
    };
}
