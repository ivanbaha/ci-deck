import { isAbsolute, resolve } from 'node:path';

export interface CliArgs {
    envPath: string;
    dbPath: string | null;
    port: number | null;
    /** Force a rebuild of the browser bundle even when public/ is present. */
    rebuild: boolean;
    help: boolean;
}

export const DEFAULT_PORT = 8787;
/** Loopback only, by design — see the security section of the README. */
export const HOSTNAME = '127.0.0.1';

export const USAGE = `CI Deck — one board for many GitLab pipelines

Usage: ci-deck [options]

Options:
  --env <path>      env file to read, if present (default: ./.env)
  --db <path>       SQLite database (default: per-user data directory)
  --port <number>   HTTP port (default: ${DEFAULT_PORT})
  --rebuild         rebuild the browser bundle before starting
  -h, --help        show this help

Configuration:
  Nothing is required up front — start CI Deck and enter your GitLab URL and
  token in the UI. Values may also come from the environment, and are merged
  per value with inline variables winning over the env file, which wins over
  what is stored:

  GITLAB_PAT        personal access token with the "api" scope
  GITLAB_BASE_URL   instance root, e.g. https://gitlab.com/
  CI_DECK_PORT      optional, overridden by --port
  CI_DECK_DB        optional, overridden by --db

The server always binds to ${HOSTNAME}. It holds your token and proxies pipeline
actions without authentication of its own, so it must stay on loopback.
`;

function requireValue(flag: string, value: string | undefined): string {
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${flag} requires a value`);
    }
    return value;
}

export function parseArgs(argv: string[], cwd: string): CliArgs {
    const toPath = (value: string) => (isAbsolute(value) ? value : resolve(cwd, value));

    const args: CliArgs = {
        envPath: resolve(cwd, '.env'),
        dbPath: null,
        port: null,
        rebuild: false,
        help: false,
    };

    for (let i = 0; i < argv.length; i += 1) {
        const flag = argv[i]!;
        switch (flag) {
            case '--env':
                args.envPath = toPath(requireValue(flag, argv[++i]));
                break;
            case '--db':
                args.dbPath = toPath(requireValue(flag, argv[++i]));
                break;
            case '--port': {
                const raw = requireValue(flag, argv[++i]);
                const port = Number.parseInt(raw, 10);
                if (!Number.isInteger(port) || port < 1 || port > 65_535) {
                    throw new Error(`Invalid --port value: ${raw}`);
                }
                args.port = port;
                break;
            }
            case '--rebuild':
                args.rebuild = true;
                break;
            case '-h':
            case '--help':
                args.help = true;
                break;
            default:
                throw new Error(`Unknown option: ${flag}`);
        }
    }

    return args;
}
