const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Fetch metadata values that mean "this did not come from another site". */
const SAFE_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

/** The spellings of loopback a browser may be pointed at. */
const LOOPBACK_NAMES = ['127.0.0.1', 'localhost', '[::1]'];

export interface GuardResult {
    ok: boolean;
    reason?: string;
}

/**
 * Everything this server agrees to be called, in the two forms the checks below
 * compare against: `Host` carries an authority, `Origin` a whole origin.
 *
 * One list rather than two rules that can drift apart. They did: `Host` accepted
 * `localhost` while `Origin` was compared against a single string built from
 * `127.0.0.1`, so opening the board at `localhost` rendered a page whose every
 * write was then refused.
 */
export interface AllowedOrigins {
    hosts: ReadonlySet<string>;
    origins: ReadonlySet<string>;
}

/**
 * Loopback on the served port is always answered to, whatever the server is
 * bound to — it is how the board is reached on the machine running it. Anything
 * else has to be declared, which is what `--bind <address>` and `--origin <url>`
 * are for.
 *
 * Each name goes through `URL` so that the two forms agree on the awkward cases:
 * a default port is dropped from both, and an IPv6 literal keeps its brackets.
 */
export function allowedOrigins(port: number, declared: readonly string[] = []): AllowedOrigins {
    const hosts = new Set<string>();
    const origins = new Set<string>();

    const allow = (origin: string) => {
        const url = new URL(origin);
        hosts.add(url.host);
        origins.add(url.origin);
    };

    for (const name of LOOPBACK_NAMES) allow(`http://${name}:${port}`);
    for (const origin of declared) allow(origin);

    return { hosts, origins };
}

/**
 * A loopback bind keeps other machines out, but any page in the user's browser
 * can still reach 127.0.0.1. Two independent checks close that off.
 *
 * `Host` first, on every method: a page on `evil.example` whose DNS is rebound to
 * 127.0.0.1 is same-origin as far as the browser is concerned, so it sends no
 * `Origin` and `Sec-Fetch-Site: same-origin` — the provenance checks below would
 * wave it through. The name the request was addressed to is the giveaway, and
 * it must be one of ours. A rebound name is never one of ours, whatever the
 * server is bound to, because names only get on the list by being declared.
 *
 * Then provenance, on writes: a cross-site form post carries a foreign `Origin`,
 * and a cross-origin fetch with custom headers needs a CORS preflight this server
 * never answers.
 *
 * Header-less clients such as curl are unaffected on purpose.
 */
export function checkRequestOrigin(request: Request, allowed: AllowedOrigins): GuardResult {
    // Node and Bun both fill `request.url` from the Host header; the fallback is
    // for constructed Requests, which carry the authority in the URL instead.
    const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
    if (!allowed.hosts.has(host)) {
        return { ok: false, reason: `host ${host} is not an address of this server` };
    }

    if (!WRITE_METHODS.has(request.method)) return { ok: true };

    const site = request.headers.get('sec-fetch-site');
    if (site && !SAFE_FETCH_SITES.has(site)) {
        return { ok: false, reason: `cross-site request blocked (sec-fetch-site: ${site})` };
    }

    const origin = request.headers.get('origin')?.toLowerCase();
    if (origin && !allowed.origins.has(origin)) {
        return { ok: false, reason: `origin ${origin} is not allowed` };
    }

    return { ok: true };
}
