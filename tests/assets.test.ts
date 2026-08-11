import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { directoryAssets, embeddedAssets } from '../src/server/assets.ts';

/** A `public/` as `buildWeb` leaves it, plus a file that has no business being served. */
async function builtPublicDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ci-deck-public-'));
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'index.html'), '<!doctype html>');
    await writeFile(join(dir, 'assets', 'main.js'), 'export {};');
    await writeFile(join(dir, 'assets', 'main.js.map'), '{}');
    await writeFile(join(dir, 'secrets.txt'), 'not an asset');
    return dir;
}

describe('directoryAssets', () => {
    it('serves the shell and the files beside it', async () => {
        const dir = await builtPublicDir();
        const assets = directoryAssets(dir);

        expect(await assets.index().text()).toBe('<!doctype html>');
        expect(await (await assets.asset('main.js'))?.text()).toBe('export {};');
        expect(await (await assets.asset('main.js.map'))?.text()).toBe('{}');
    });

    it('has nothing to say about a file that is not there', async () => {
        const assets = directoryAssets(await builtPublicDir());
        expect(await assets.asset('nope.js')).toBeNull();
    });

    // A 404 rather than a read: the name goes into a path, so the shapes that
    // could climb out of assets/ never reach the filesystem.
    it('refuses names that are not names', async () => {
        const dir = await builtPublicDir();
        const assets = directoryAssets(dir);

        for (const name of ['', '.', '..', '../secrets.txt', '..%2fsecrets.txt', 'sub/main.js', '.env']) {
            expect(await assets.asset(name)).toBeNull();
        }
    });

    it('will not serve a file that buildWeb did not put under assets/', async () => {
        const assets = directoryAssets(await builtPublicDir());
        expect(await assets.asset('secrets.txt')).toBeNull();
    });
});

describe('embeddedAssets', () => {
    const paths = {
        index: '/$bunfs/root/index-aaaa.html',
        main: '/$bunfs/root/main-bbbb.js',
    };

    const assets = embeddedAssets(paths.index, { 'main.js': paths.main });

    it('points at what the compiler embedded', () => {
        expect(assets.index().name).toBe(paths.index);
    });

    it('resolves an embedded name to its file', async () => {
        expect((await assets.asset('main.js'))?.name).toBe(paths.main);
    });

    it('has nothing to say about a name that was not embedded', async () => {
        expect(await assets.asset('app.css')).toBeNull();
    });

    // Object lookup would answer these from the prototype, and Bun.file would
    // then be handed something that is not a path.
    it('does not answer with anything off Object.prototype', async () => {
        for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
            expect(await assets.asset(name)).toBeNull();
        }
    });
});
