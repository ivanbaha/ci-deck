# Security

## Reporting a vulnerability

Report privately through GitHub's
[security advisory form](https://github.com/ivanbaha/ci-deck/security/advisories/new)
rather than in a public issue. Expect an acknowledgement within a week.

Please include what an attacker gains, the steps to reproduce it, and the CI Deck and Bun
versions you saw it on.

## Supported versions

The most recent release only. CI Deck is a local tool with no server side, so upgrading is
`bun add -g ci-deck@latest`.

## What is in scope

CI Deck runs on your machine, binds to `127.0.0.1` by default, and holds a GitLab personal
access token that can act as you. Findings that matter most:

- Anything that gets the token out of the process — into a log, an API response, an export
  file, or a request to a host other than the configured GitLab instance.
- Anything that lets a web page you have open in the same browser reach the API, defeating
  the `Host`, `Origin` and `Sec-Fetch-Site` checks in [`src/server/guard.ts`](src/server/guard.ts).
- Anything that reads or writes files outside the package's own `public/` directory through
  the asset route, or that turns a GitLab job log into executable markup in the page.
- Dependency or supply-chain problems in the published package. CI Deck has no runtime
  dependencies, and releases are published from GitHub Actions with
  [npm provenance](https://docs.npmjs.com/generating-provenance-statements), so
  `npm audit signatures` should confirm where a given version was built.

## What is not in scope

These are documented design choices, not oversights — see the Security section of the
[README](README.md#security):

- **No authentication on the local HTTP port.** Anyone who can already reach loopback on
  your machine is inside the trust boundary.
- **A board deliberately put on a network is yours to protect.** `--bind` takes any address
  and the container image uses it, which is what makes a published port work. CI Deck says
  so loudly at startup and the README says it twice: there is no authentication, so
  whatever can reach the port can act as you. Reaching an exposed board is not a finding.
  Reaching one that was *not* exposed — anything that gets past `--bind`, or past the
  `Host` check on a board bound to loopback — very much is.
- **Plain-text token storage on Linux and BSD.** There is no OS credential store to use,
  and encrypting with a key the app can derive on its own is obfuscation, not protection.
  The UI says so, and the data directory is `0700`.
- **A token you gave it is a token it will use.** CI Deck acts on GitLab as you, by design.
- **OS package findings the image cannot reach.** The container image upgrades its Alpine
  packages at build time, so a scan of a freshly built image shows nothing Alpine has
  patched. What it does still report is
  [CVE-2025-60876](https://security.alpinelinux.org/vuln/CVE-2025-60876) — request
  splitting through BusyBox's `wget` applet, which Alpine has not fixed on any branch.
  Nothing in the image runs `wget`: the health check is `bun -e` and `fetch`, and the only
  subprocesses CI Deck ever starts are the macOS and Windows credential stores. Please do
  report an OS package finding that something in CI Deck actually calls.
