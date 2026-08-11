import { isAbsolute, resolve } from 'node:path';

export interface CliArgs {
    envPath: string;
    dbPath: string | null;
    port: number | null;
    /** Address to listen on. Loopback unless someone says otherwise. */
    bind: string;
    /** Extra origins the board is reached by, normalised. */
    origins: string[];
    /** Force a rebuild of the browser bundle even when public/ is present. */
    rebuild: boolean;
    help: boolean;
    version: boolean;
}

export const DEFAULT_PORT = 8787;
/** Loopback by default — see the security section of the README. */
export const DEFAULT_BIND = '127.0.0.1';

/** Addresses meaning "every interface", where no single one is the one to browse to. */
const WILDCARD_BINDS = new Set(['0.0.0.0', '::', '[::]']);

/** Whether this address keeps the server off the network. */
export function isLoopbackBind(address: string): boolean {
    const bind = address.trim().toLowerCase();
    // All of 127.0.0.0/8 is loopback, not just the address people write.
    return bind === 'localhost' || bind === '::1' || bind === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(bind);
}

/**
 * The origin a browser reaches a server bound to this address by, so the guard
 * can answer to it. Null for a wildcard, which is not a name anything can be
 * pointed at.
 *
 * Loopback comes back as an origin too, repeating what the guard allows anyway,
 * rather than being filtered here against a list of what it already knows —
 * that list would be free to drift, and a name missing from it is a board that
 * loads and then refuses every write.
 */
export function originForBind(address: string, port: number): string | null {
    const bind = address.trim().toLowerCase();
    if (WILDCARD_BINDS.has(bind)) return null;

    // An IPv6 literal needs brackets before it can go in a URL.
    const host = bind.includes(':') && !bind.startsWith('[') ? `[${bind}]` : bind;
    return `http://${host}:${port}`;
}

/**
 * `rebuild` is false for the standalone binary: its assets are built in, and
 * there is no `web/` beside it to rebuild them from.
 */
export function usage({ rebuild }: { rebuild: boolean }): string {
    const options = [
        '  --env <path>      env file to read, if present (default: ./.env)',
        '  --db <path>       SQLite database (default: per-user data directory)',
        `  --port <number>   HTTP port (default: ${DEFAULT_PORT})`,
        `  --bind <address>  address to listen on (default: ${DEFAULT_BIND})`,
        '  --origin <url>    another origin the board is reached by; repeatable',
        ...(rebuild ? ['  --rebuild         rebuild the browser bundle before starting'] : []),
        '  -h, --help        show this help',
        '  -v, --version     show the version',
    ];

    return `CI Deck — one board for many GitLab pipelines

Usage: ci-deck [options]

Options:
${options.join('\n')}

Configuration:
  Nothing is required up front — start CI Deck and enter your GitLab URL and
  token in the UI. Values may also come from the environment, and are merged
  per value with inline variables winning over the env file, which wins over
  what is stored:

  GITLAB_PAT        personal access token with the "api" scope
  GITLAB_BASE_URL   instance root, e.g. https://gitlab.com/
  CI_DECK_PORT      optional, overridden by --port
  CI_DECK_DB        optional, overridden by --db

The server binds to ${DEFAULT_BIND} unless --bind says otherwise. It holds your token and
proxies pipeline actions with no authentication of its own, so whatever can reach the
port can act as you on GitLab. Loopback and the address given to --bind are answered
to; any other name the board is reached by has to be named with --origin.
`;
}

function requireValue(flag: string, value: string | undefined): string {
    if (value === undefined || value.startsWith('--')) {
        throw new Error(`Option ${flag} requires a value`);
    }
    return value;
}

/**
 * An origin is a scheme, a host and a port — the form a browser puts in the
 * `Origin` header. Anything more is a sign of a misunderstanding worth saying
 * out loud, since the extra part would be silently dropped.
 */
function requireOrigin(value: string): string {
    let url: URL;
    try {
        url = new URL(value.trim());
    } catch {
        throw new Error(`Invalid --origin value: ${value} — expected something like http://ci-deck.example:8787`);
    }

    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`--origin must be http or https, got ${url.protocol}`);
    }

    if (url.pathname !== '/' || url.search || url.hash) {
        throw new Error(`--origin takes a scheme, host and port only: ${value}`);
    }

    return url.origin;
}

export function parseArgs(argv: string[], cwd: string): CliArgs {
    const toPath = (value: string) => (isAbsolute(value) ? value : resolve(cwd, value));

    const args: CliArgs = {
        envPath: resolve(cwd, '.env'),
        dbPath: null,
        port: null,
        bind: DEFAULT_BIND,
        origins: [],
        rebuild: false,
        help: false,
        version: false,
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
            case '--bind':
                args.bind = requireValue(flag, argv[++i]).trim();
                break;
            case '--origin':
                args.origins.push(requireOrigin(requireValue(flag, argv[++i])));
                break;
            case '--rebuild':
                args.rebuild = true;
                break;
            case '-h':
            case '--help':
                args.help = true;
                break;
            case '-v':
            case '--version':
                args.version = true;
                break;
            default:
                throw new Error(`Unknown option: ${flag}`);
        }
    }

    return args;
}
