# Changelog

All notable changes to CI Deck are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor
versions may still change behaviour.

## [Unreleased]

### Added

- **Standalone executables.** Every release now carries one per platform — macOS, Linux
  and Windows — each with the board's assets and the Bun runtime compiled in, so the tool
  can be downloaded and run without installing Bun. They take the same flags, `.env`,
  database and credential store as the package; only `--rebuild` is gone, since a single
  file carries no `web/` to rebuild from. Build them with `bun run compile`.
- **A `SHA256SUMS` file and build provenance** for those executables. A download can be
  checked with `shasum -a 256 -c` and verified against the workflow that produced it with
  `gh attestation verify` — the same claim `npm publish --provenance` makes for the
  package.
- **`--version`**, and the version in the startup banner. A copy that arrived by `curl`
  has no package manager to ask what it is.
- **A container image**, on Docker Hub as `ivbaha/ci-deck` and on GHCR as
  `ghcr.io/ivanbaha/ci-deck`, for `linux/amd64` and `linux/arm64`. One build is pushed to
  both, so they share a digest. It carries no dependencies beyond Bun itself, runs
  unprivileged, keeps the watch list on a `/data` volume, and binds `0.0.0.0` inside the
  container so a published port reaches it — publish that port on `127.0.0.1` to keep the
  board off the network. The same command works on Docker, on Apple's `container`, and with
  a bind-mounted host directory: the entrypoint hands the data directory to the
  unprivileged user before dropping to it, rather than depending on a runtime that copies
  the image's ownership onto a new volume.
- **`--bind <address>` and `--origin <url>`.** The server still binds to `127.0.0.1` by
  default, but it no longer has to: `--bind` puts it on another address, which is what a
  container needs, and warns at startup whenever that address is not loopback. It answers
  to loopback and to whatever it was bound to; any other name the board is reached by — a
  hostname, or a port something maps to a different one — is named with `--origin`. A name
  still only gets on that list by being declared, so DNS rebinding is no more possible
  than before.

### Fixed

- Opening the board at `localhost` rendered a page whose every write was then refused. The
  host check knew that name and the origin check did not; both now read one allowlist.
- `/assets/__proto__` and friends answered from `Object.prototype` instead of 404ing,
  turning a missing asset into a server error. Only reachable in the standalone build.
- A bind address that is not this machine's now says so, instead of reporting a stack trace
  that blames the port.
- A database that cannot be opened now names the path and the user it tried as, rather than
  passing SQLite's "unable to open database file" along with a stack trace. A mounted volume
  owned by someone else is the usual cause, and says nothing about SQLite.

## [0.1.0] — 2026-08-09

First stable release, and the same code as `0.1.0-b1` — that pre-release existed only to
claim the package name so npm trusted publishing could be configured. This one is published
over OIDC and takes the `latest` tag.

Everything below is new, so this entry describes the tool rather than listing changes
against a previous release.

### Added

- **The board.** One row per watched repo showing the most recent pipeline on its branch:
  status, pipeline number, commit, stage bubbles, and when it was last updated and last
  checked. Rows are grouped into sections by GitLab namespace, each counting its repos and
  its failures; failed rows name the jobs that failed. The top bar, the column header and
  the current section stay put as you scroll.
- **Stage and job controls.** Expand a stage for its jobs, read a job log with ANSI colours
  preserved and progress-bar spam collapsed, and retry, cancel or start a manual job.
  Starting a manual job asks for confirmation first. The log view follows a job across a
  retry even though its id changes.
- **Row controls.** Check now, retry the pipeline's failed jobs, cancel a running pipeline,
  pause or resume watching, remove from the board.
- **Filtering.** Tabs that count and filter by status, plus a group dropdown and a search
  box that takes a comma-separated list as an OR. Sections disappear when nothing in them
  matches.
- **Polling.** Serial sweeps, one repo at a time, on a configurable interval (30s to 15m,
  default 2m). Two request lanes keep the UI responsive mid-sweep. Jobs are cached only
  when the pipeline cannot change. 5 retries with exponential backoff honouring
  `Retry-After`; 401/403 stops polling and shows a banner.
- **Credentials.** Set up in the UI and verified against GitLab before being stored. The
  token goes to the Windows DPAPI store or the macOS Keychain where available, and to the
  database in plain text otherwise, with the UI saying which. It is never logged, never
  returned by the API and never exported. The connection button in the top bar carries the
  state: amber when the instance is unreachable, red when GitLab rejects the token.
- **Configuration.** `GITLAB_PAT`, `GITLAB_BASE_URL`, `CI_DECK_PORT` and `CI_DECK_DB`,
  layered per value: inline environment, then env file, then what the UI saved. The UI
  shows where each value came from.
- **CLI.** `--env`, `--db`, `--port`, `--rebuild`, `--help`.
- **Import and export** of the watch list. Import opens a dialog you can drop a file onto,
  offers a template, and says how many repos it would add before anything is sent; every
  skipped entry is listed with its reason. Import is additive, and re-resolves by path when
  the list came from a different GitLab instance.
- **Security posture.** Loopback-only binding with no flag to change it, a `Host` check
  against DNS rebinding, cross-site write rejection via `Origin` and `Sec-Fetch-Site`, a
  strict CSP with no inline script, and a stored token that only ever goes to the host it
  was saved for.

### Not switched on yet

- **Tags.** Repos can carry overlapping, hand-made labels that filter the board across
  namespaces and can limit the sweep to what you are looking at. The store, the API and the
  export format already carry them, and an export written now keeps them; the interface is
  still being worked out, so it is off unless `CI_DECK_TAGS=1` is set. Expect it to change.

## [0.1.0-b1] — 2026-08-08

Bootstrap pre-release, published under the `beta` tag. Functionally identical to `0.1.0`;
it existed so that npm trusted publishing could be configured against a package that
already exists. See the `0.1.0` entry for what it contains.

[Unreleased]: https://github.com/ivanbaha/ci-deck/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ivanbaha/ci-deck/releases/tag/v0.1.0
[0.1.0-b1]: https://github.com/ivanbaha/ci-deck/releases/tag/v0.1.0-b1
