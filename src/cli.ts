#!/usr/bin/env bun
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_PORT, HOSTNAME, parseArgs, USAGE, type CliArgs } from './config/args.ts';
import {
    applyEnvValues,
    EnvError,
    readEnvFile,
    readOptionalDbPath,
    readOptionalPort,
    unexplainedByFiles,
} from './config/env.ts';
import { defaultDbPath } from './config/paths.ts';
import { Secrets } from './config/secrets.ts';
import { Runtime } from './core/runtime.ts';
import { describeError } from './gitlab/errors.ts';
import { createServeOptions } from './server/app.ts';
import { buildWeb } from './server/build-web.ts';
import { WatchStore } from './store/watch-store.ts';

const PROJECT_ROOT = resolve(import.meta.dir, '..');
const PUBLIC_DIR = resolve(PROJECT_ROOT, 'public');

function fail(message: string): never {
    process.stderr.write(`\n${message}\n\n`);
    process.exit(1);
}

const args: CliArgs = (() => {
    try {
        return parseArgs(process.argv.slice(2), process.cwd());
    } catch (error) {
        return fail(`${describeError(error)}\n\n${USAGE}`);
    }
})();

if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
}

// Bun has already applied ./.env by this point, so read the files ourselves and
// attribute each value: an explicit --env file outranks ./.env, and anything no
// file explains is inline.
const autoEnvPath = resolve(process.cwd(), '.env');
const autoEnv = readEnvFile(autoEnvPath);
const explicitEnv = args.envPath === autoEnvPath ? { values: {} } : readEnvFile(args.envPath);
const fileValues = { ...autoEnv.values, ...explicitEnv.values };

applyEnvValues(fileValues);
const inline = unexplainedByFiles(process.env, fileValues);

const runtimeSettings = (() => {
    try {
        return {
            port: args.port ?? readOptionalPort() ?? DEFAULT_PORT,
            dbPath: args.dbPath ?? readOptionalDbPath() ?? defaultDbPath(),
        };
    } catch (error) {
        if (error instanceof EnvError) return fail(describeError(error));
        throw error;
    }
})();

const watchStore = WatchStore.open(runtimeSettings.dbPath);
const secrets = new Secrets();

const runtime = new Runtime({
    watchStore,
    secrets,
    layers: { inline, file: fileValues },
});

await runtime.bootstrap();

if (args.rebuild || !existsSync(resolve(PUBLIC_DIR, 'index.html'))) {
    await buildWeb(PROJECT_ROOT).catch((error) => fail(describeError(error)));
}

const server = Bun.serve({
    hostname: HOSTNAME,
    port: runtimeSettings.port,
    idleTimeout: 0,
    ...createServeOptions({
        runtime,
        watchStore,
        publicDir: PUBLIC_DIR,
        selfOrigin: `http://${HOSTNAME}:${runtimeSettings.port}`,
    }),
});

const meta = runtime.appStore.snapshot().meta;
const settings = watchStore.settings;
const watched = meta.gitlabBaseUrl ? watchStore.countFor(meta.gitlabBaseUrl) : 0;

const lines = ['', `  CI Deck    →  http://${HOSTNAME}:${server.port}`, ''];

if (runtime.configured) {
    lines.push(
        `  GitLab     ${meta.gitlabBaseUrl} as ${meta.user}`,
        `  Watching   ${watched} repo${watched === 1 ? '' : 's'}, one at a time`,
        `  Interval   ${settings.pollPeriodSeconds}s, ${settings.retries} retries per request`,
        `  Store      ${watchStore.path}`,
    );
    if (meta.credentials.reachError) {
        lines.push('', `  Warning    ${meta.gitlabBaseUrl} is not reachable yet — retrying while it stays down`);
    }
    if (watched === 0) {
        lines.push('', '  The watch list is empty — add repos in the UI.');
    }
} else {
    lines.push(
        `  Store      ${watchStore.path}`,
        `  Secrets    ${meta.credentials.storageLabel}`,
        '',
        '  Not configured yet — open the URL above and enter your GitLab URL and token.',
    );
    if (meta.credentials.authError) lines.push(`  GitLab said: ${meta.credentials.authError}`);
}

console.log(`${lines.join('\n')}\n`);

let shuttingDown = false;
const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.stop();
    await server.stop(true);
    watchStore.close();
    process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
