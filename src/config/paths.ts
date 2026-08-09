import { homedir, platform } from 'node:os';
import { posix, win32 } from 'node:path';

export const APP_DIR_NAME = 'ci-deck';
export const DB_FILE_NAME = 'ci-deck.db';

/**
 * Per-user data directory, following each platform's convention so a global
 * install keeps its database outside the package folder. The separator style is
 * chosen from the target platform rather than the host, which keeps the result
 * correct — and testable — everywhere.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env, os = platform()): string {
    const home = env.HOME || env.USERPROFILE || homedir();

    if (os === 'win32') {
        const base = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local');
        return win32.join(base, APP_DIR_NAME);
    }

    if (os === 'darwin') {
        return posix.join(home, 'Library', 'Application Support', APP_DIR_NAME);
    }

    const base = env.XDG_DATA_HOME || posix.join(home, '.local', 'share');
    return posix.join(base, APP_DIR_NAME);
}

export function defaultDbPath(env: NodeJS.ProcessEnv = process.env, os = platform()): string {
    const dir = dataDir(env, os);
    return os === 'win32' ? win32.join(dir, DB_FILE_NAME) : posix.join(dir, DB_FILE_NAME);
}
