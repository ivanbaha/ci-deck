# Contributing

Thanks for looking. CI Deck is a small, dependency-free Bun app, so getting from a clone to
a running board is short.

## Getting set up

```bash
bun install
bun run start        # → http://127.0.0.1:8790
```

You need [Bun](https://bun.sh) 1.2.3 or newer — that is where `Bun.serve`'s router landed
— and a GitLab personal access token with the `api` scope. There is nothing else to
install; Bun's own HTTP server, SQLite and bundler do all the work.

Point it at a scratch database while you work, so your real watch list stays out of it:

```bash
bun run start -- --db ./scratch.db --port 8790
```

## Everyday commands

```bash
bun run dev         # watch mode, rebuilds assets
bun run typecheck
bun test
bun run build:web   # bundle web/ into public/
```

Assets are built automatically on first start and by `prepack`; `--rebuild` forces it. That
flag is for working on `web/`: it writes into the package directory, which is fine in a
checkout and pointless in an installed copy, where the bundle already ships built.

## How the code is laid out

- `src/config` — CLI args, env layering, platform paths, OS credential stores.
- `src/store` — SQLite list, tags, settings and credential references.
- `src/gitlab` — API client with retries and lane gating.
- `src/core` — runtime, poller, request lanes, stage aggregation, repo resolution.
- `src/server` — Bun routes, SSE, origin guard.
- `src/shared` — types and the watch-list file format, the parts both sides use. The import
  dialog previews a file with the very parser the server will run on it.
- `web/` — browser app, bundled by Bun into `public/`. No UI framework: small `button()`,
  `openModal()` and `openMenu()` components, inline SVG icons and hand-written CSS on
  GitLab's dark palette.
- `tests/` — Bun tests for the pure logic: stage aggregation, retries, lanes, secrets,
  config layering, the store, poller behaviour, the origin guard and ANSI rendering.

## What CI checks

Every push and pull request runs typecheck, tests and a bundle build on Linux, macOS and
Windows — the credential store and data directory differ per platform. A separate job boots
the server on Bun 1.2.3 to keep the floor in `engines` honest, and another packs the
package and fails if the browser bundle is missing from the tarball.

## Things worth knowing before you change them

- **The server binds to loopback and has no authentication.** Anything that widens its
  reach is a security change, not a feature. Writes are guarded twice: the `Host` header
  must name this server, and cross-site `Origin` or `Sec-Fetch-Site` is refused.
- **The token is never returned by the API** — only a mask, its source and where it is
  stored — and never appears in an export.
- **Sweeps are serial on purpose.** One repo at a time, spaced apart, never overlapping.
  Concurrency here spends someone's GitLab rate limit.
- **Tags are switched off by default.** The store, API and export format carry them; the
  interface is behind `CI_DECK_TAGS=1` while it is still being worked out. Expect it to
  change, and prefer changing it over building on top of it for now.

## Icons

Icons are bare SVG paths on a 24×24 grid in `web/icons.ts`, so they inherit `currentColor`
and need no build step or network request. If you add one:

- one `<path>`, no `id`, `<defs>`, `<mask>`, gradients or live strokes — outline strokes
  into fills, because a `stroke-width` scales to nothing at 8px;
- status icons are normalised so their ink fills the same share of the box, which is what
  lets a single size work everywhere. Match that;
- nothing thinner than 2 grid units, and it has to read at 8px;
- note the source and licence: everything shipped has to be redistributable under
  Apache-2.0.

## Releasing

Releases are written by hand and published by publishing them — pushing a tag on its own
does nothing.

1. Bump `version` in `package.json` and land it on `main`.
2. Draft a release in GitHub against tag `v<version>`. Tick **pre-release** when the
   version carries a suffix like `0.1.0-b1`; the workflow refuses to run if the two
   disagree, because a pre-release published as `latest` reaches everyone.
3. Publish the release. That runs the checks again at that exact commit, refuses a version
   already on the registry, and publishes to npm — under `beta` for a pre-release, `latest`
   otherwise — then attaches the tarball to your release.

Running the workflow by hand instead is a rehearsal: it stops at `npm publish --dry-run`
and cannot publish.

The `release` workflow is only picked up from the file on the default branch, so changes to
it have to land on `main` before they take effect.

**Trusted publishing.** npm only lets a trusted publisher be configured on a package that
already exists, so the first release needs a granular `NPM_TOKEN` repository secret. Once
it is published, add the trusted publisher on npmjs.com for this repo and workflow, then
delete the secret — the workflow switches to OIDC on its own, and provenance becomes
automatic instead of a flag.

Notable changes go in [`CHANGELOG.md`](./CHANGELOG.md).

## Security

Found a security problem? [`SECURITY.md`](./SECURITY.md) says where to send it — please do
not open a public issue for it.
