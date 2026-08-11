import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWeb } from '../src/server/build-web.ts';

/**
 * Standalone executables, for people who want the board without installing Bun.
 *
 * Usage: bun run compile [target...]   (default: this machine; `all` for every one)
 *
 * The Linux builds link against glibc, which is what the mainstream
 * distributions use. Alpine would need the `-musl` variants, and nobody has
 * asked for one yet.
 */
const TARGETS = {
    'linux-x64': 'bun-linux-x64',
    'linux-arm64': 'bun-linux-arm64',
    'darwin-x64': 'bun-darwin-x64',
    'darwin-arm64': 'bun-darwin-arm64',
    'windows-x64': 'bun-windows-x64',
} as const;

type TargetName = keyof typeof TARGETS;

const NAMES = Object.keys(TARGETS) as TargetName[];

const isTarget = (name: string): name is TargetName => name in TARGETS;

function hostTarget(): TargetName {
    const os = process.platform === 'win32' ? 'windows' : process.platform;
    const name = `${os}-${process.arch}`;
    if (!isTarget(name)) throw new Error(`No published target for ${process.platform}/${process.arch}`);
    return name;
}

function requestedTargets(argv: string[]): TargetName[] {
    if (argv.length === 0) return [hostTarget()];
    if (argv.length === 1 && argv[0] === 'all') return NAMES;

    return argv.map((name) => {
        if (!isTarget(name)) {
            throw new Error(`Unknown target ${name} — pick from ${NAMES.join(', ')}, or "all"`);
        }
        return name;
    });
}

/**
 * `bun build --compile` stages the executable next to the working directory and
 * leaves that copy behind — one hidden `.bun-build` file per target, each as
 * large as the binary itself. Nothing else writes them, so they can be swept.
 */
async function sweepStagedBuilds(dir: string): Promise<void> {
    for (const name of await readdir(dir)) {
        if (name.startsWith('.') && name.endsWith('.bun-build')) {
            await rm(resolve(dir, name), { force: true });
        }
    }
}

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distDir = resolve(projectRoot, 'dist');
const entrypoint = resolve(projectRoot, 'src/binary.ts');

const targets = requestedTargets(process.argv.slice(2));

// The executable embeds what is in `public/`, so it has to be current — a stale
// bundle here would ship silently and only show up in the browser.
await buildWeb(projectRoot);

await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

try {
    for (const target of targets) {
        const outfile = resolve(distDir, `ci-deck-${target}${target.startsWith('windows') ? '.exe' : ''}`);

        // Cross-compiling downloads the Bun runtime for the target the first time,
        // so the first build for a platform is much slower than the rest.
        const child = Bun.spawn(
            ['bun', 'build', '--compile', `--target=${TARGETS[target]}`, '--outfile', outfile, entrypoint],
            { cwd: projectRoot, stdout: 'inherit', stderr: 'inherit' },
        );

        if ((await child.exited) !== 0) {
            throw new Error(`bun build failed for ${target}`);
        }

        const megabytes = ((await stat(outfile)).size / 1_000_000).toFixed(1);
        console.log(`  ${outfile.slice(projectRoot.length + 1)}  ${megabytes} MB`);
    }
} finally {
    await sweepStagedBuilds(projectRoot);
}
