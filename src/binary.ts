import appCss from '#built/assets/app.css' with { type: 'file' };
import favicon from '#built/assets/favicon.svg' with { type: 'file' };
import mainJs from '#built/assets/main.js' with { type: 'file' };
import mainJsMap from '#built/assets/main.js.map' with { type: 'file' };
import indexHtml from '#built/index.html' with { type: 'file' };
import { usage } from './config/args.ts';
import { embeddedAssets } from './server/assets.ts';
import { start } from './start.ts';

// The entrypoint `bun build --compile` turns into a standalone executable: one
// file, no Bun to install, and the browser bundle embedded above rather than
// read from `public/`. Everything it imports is compiled in with it, so the
// binary has no source tree to be run from — see scripts/compile.ts.
//
// `public/` has to be built before this compiles; the script does that first.

await start({
    argv: process.argv.slice(2),
    usage: usage({ rebuild: false }),
    assets: embeddedAssets(indexHtml, {
        'main.js': mainJs,
        'main.js.map': mainJsMap,
        'app.css': appCss,
        'favicon.svg': favicon,
    }),
    prepare: async (args) => {
        if (args.rebuild) {
            throw new Error(
                '--rebuild builds the browser bundle from web/, which a standalone binary does not carry.\n'
                + 'Its assets are already built in. To work on the UI, run CI Deck from a checkout.',
            );
        }
    },
});
