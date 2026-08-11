import { resolve } from 'node:path';
import {
    DEFAULT_BIND,
    DEFAULT_PORT,
    isLoopbackBind,
    originForBind,
    parseArgs,
    type CliArgs,
} from './config/args.ts';
import {
    applyEnvValues,
    EnvError,
    readEnvFile,
    readOptionalDbPath,
    readOptionalPort,
    scrubSecretEnv,
    unexplainedByFiles,
} from './config/env.ts';
import { defaultDbPath } from './config/paths.ts';
import { Secrets } from './config/secrets.ts';
import { Runtime } from './core/runtime.ts';
import { describeError } from './gitlab/errors.ts';
import { createServeOptions } from './server/app.ts';
import type { Assets } from './server/assets.ts';
import { allowedOrigins } from './server/guard.ts';
import { StoreError, WatchStore } from './store/watch-store.ts';
import { VERSION } from './version.ts';

export interface StartOptions {
    /** Arguments without the executable and the script name. */
    argv: string[];
    /** Help text, which differs between a checkout and a standalone binary. */
    usage: string;
    assets: Assets;
    /**
     * Whatever this entrypoint needs in place before it can serve. It runs as
     * soon as the arguments are understood and before anything touches the
     * database or GitLab, so a bundle that cannot be built is reported in
     * milliseconds rather than after a round trip.
     */
    prepare?: (args: CliArgs) => Promise<void>;
}

function fail(message: string): never {
    process.stderr.write(`\n${message}\n\n`);
    process.exit(1);
}

/**
 * Everything between a command line and a running board. Both entrypoints —
 * the script in a checkout and the compiled binary — differ only in where the
 * browser assets come from, and in whether they can rebuild them.
 */
export async function start(options: StartOptions): Promise<void> {
    const args: CliArgs = (() => {
        try {
            return parseArgs(options.argv, process.cwd());
        } catch (error) {
            return fail(`${describeError(error)}\n\n${options.usage}`);
        }
    })();

    if (args.help) {
        process.stdout.write(options.usage);
        process.exit(0);
    }

    if (args.version) {
        process.stdout.write(`ci-deck ${VERSION}\n`);
        process.exit(0);
    }

    if (options.prepare) {
        try {
            await options.prepare(args);
        } catch (error) {
            fail(describeError(error));
        }
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
    // The layers hold the token from here on; nothing reads it off the environment,
    // and what is not in the environment cannot be inherited or read out of it.
    scrubSecretEnv();

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

    const watchStore = (() => {
        try {
            return WatchStore.open(runtimeSettings.dbPath);
        } catch (error) {
            if (error instanceof StoreError) return fail(describeError(error));
            throw error;
        }
    })();

    const secrets = new Secrets();

    const runtime = new Runtime({
        watchStore,
        secrets,
        layers: { inline, file: fileValues },
    });

    await runtime.bootstrap();

    // A specific address is one the board can be opened at, so it answers to its
    // own name as well as to loopback. A rebound DNS name still cannot get on
    // the list: names arrive by being declared, never by resolving here.
    const boundOrigin = originForBind(args.bind, runtimeSettings.port);

    // An address that is not this machine's is a plausible typo now that --bind
    // takes one, and Bun reports it as "is the port in use?" over a stack trace.
    let server: ReturnType<typeof Bun.serve>;
    try {
        server = Bun.serve({
            hostname: args.bind,
            port: runtimeSettings.port,
            idleTimeout: 0,
            ...createServeOptions({
                runtime,
                watchStore,
                assets: options.assets,
                origins: allowedOrigins(runtimeSettings.port, [
                    ...(boundOrigin ? [boundOrigin] : []),
                    ...args.origins,
                ]),
            }),
        });
    } catch (error) {
        await runtime.stop();
        watchStore.close();
        fail(
            `Cannot listen on ${args.bind}:${runtimeSettings.port} — ${describeError(error)}\n\n`
            + 'Either something already holds that port, or the address is not one this machine has.',
        );
    }

    const meta = runtime.appStore.snapshot().meta;
    const settings = watchStore.settings;
    const watched = meta.gitlabBaseUrl ? watchStore.countFor(meta.gitlabBaseUrl) : 0;

    const boardUrl = boundOrigin ?? `http://${DEFAULT_BIND}:${server.port}`;
    const lines = ['', `  CI Deck    →  ${boardUrl}`, '', `  Version    ${VERSION}`];

    if (args.bind !== DEFAULT_BIND) lines.push(`  Bind       ${args.bind}`);

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

    if (!isLoopbackBind(args.bind)) {
        lines.push(
            '',
            `  Warning    ${args.bind} is not loopback. CI Deck has no authentication, so`,
            '             anything that can reach this port can act as you on GitLab.',
        );
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
}
