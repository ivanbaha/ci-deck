# Changelog

All notable changes to CI Deck are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor
versions may still change behaviour.

## [Unreleased]

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
