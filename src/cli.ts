#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { usage } from './config/args.ts';
import { directoryAssets } from './server/assets.ts';
import { buildWeb } from './server/build-web.ts';
import { start } from './start.ts';

// The entrypoint for a checkout and for an installed package: `web/` is beside
// us, so the bundle can be built on demand. See src/binary.ts for the standalone
// executable, which carries the built assets instead.
const PROJECT_ROOT = resolve(import.meta.dir, '..');
const PUBLIC_DIR = resolve(PROJECT_ROOT, 'public');

await start({
    argv: process.argv.slice(2),
    usage: usage({ rebuild: true }),
    assets: directoryAssets(PUBLIC_DIR),
    prepare: async (args) => {
        if (args.rebuild || !existsSync(resolve(PUBLIC_DIR, 'index.html'))) {
            await buildWeb(PROJECT_ROOT);
        }
    },
});
