const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Fetch metadata values that mean "this did not come from another site". */
const SAFE_FETCH_SITES = new Set(['same-origin', 'same-site', 'none']);

export interface GuardResult {
    ok: boolean;
    reason?: string;
}

/**
 * The names this server answers to. Anything else in `Host` means the request
 * was addressed to a different name that merely resolves here.
 */
export function allowedHosts(selfOrigin: string): Set<string> {
    const port = new URL(selfOrigin).port;
    const suffix = port ? `:${port}` : '';
    return new Set([`127.0.0.1${suffix}`, `localhost${suffix}`, `[::1]${suffix}`]);
}

/**
 * Loopback binding keeps other machines out, but any page in the user's browser
 * can still reach 127.0.0.1. Two independent checks close that off.
 *
 * `Host` first, on every method: a page on `evil.example` whose DNS is rebound to
 * 127.0.0.1 is same-origin as far as the browser is concerned, so it sends no
 * `Origin` and `Sec-Fetch-Site: same-origin` — the provenance checks below would
 * wave it through. The name the request was addressed to is the giveaway, and
 * it must be one of ours.
 *
 * Then provenance, on writes: a cross-site form post carries a foreign `Origin`,
 * and a cross-origin fetch with custom headers needs a CORS preflight this server
 * never answers.
 *
 * Header-less clients such as curl are unaffected on purpose.
 */
export function checkRequestOrigin(request: Request, selfOrigin: string): GuardResult {
    // Node and Bun both fill `request.url` from the Host header; the fallback is
    // for constructed Requests, which carry the authority in the URL instead.
    const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
    if (!allowedHosts(selfOrigin).has(host)) {
        return { ok: false, reason: `host ${host} is not an address of this server` };
    }

    if (!WRITE_METHODS.has(request.method)) return { ok: true };

    const site = request.headers.get('sec-fetch-site');
    if (site && !SAFE_FETCH_SITES.has(site)) {
        return { ok: false, reason: `cross-site request blocked (sec-fetch-site: ${site})` };
    }

    const origin = request.headers.get('origin');
    if (origin && origin !== selfOrigin) {
        return { ok: false, reason: `origin ${origin} is not allowed` };
    }

    return { ok: true };
}
