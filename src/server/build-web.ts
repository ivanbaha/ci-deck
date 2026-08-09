import { copyFile, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Bundles the browser app into `public/`. Runs on every start — Bun does it in
 * milliseconds, which keeps the served assets from ever going stale.
 */
export async function buildWeb(projectRoot: string): Promise<void> {
    const webDir = resolve(projectRoot, 'web');
    const publicDir = resolve(projectRoot, 'public');
    const assetsDir = resolve(publicDir, 'assets');

    await rm(assetsDir, { recursive: true, force: true });
    await mkdir(assetsDir, { recursive: true });

    const result = await Bun.build({
        entrypoints: [resolve(webDir, 'main.ts')],
        outdir: assetsDir,
        target: 'browser',
        sourcemap: 'linked',
    });

    if (!result.success) {
        throw new Error(`Web bundle failed:\n${result.logs.map(String).join('\n')}`);
    }

    await copyFile(resolve(webDir, 'index.html'), resolve(publicDir, 'index.html'));
    await copyFile(resolve(webDir, 'styles.css'), resolve(assetsDir, 'app.css'));
    await copyFile(resolve(webDir, 'favicon.svg'), resolve(assetsDir, 'favicon.svg'));
}
