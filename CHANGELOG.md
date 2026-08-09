# Changelog

All notable changes to CI Deck are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor
versions may still change behaviour.

## [Unreleased]

## [0.1.0-b1] — 2026-08-08

First public beta. Everything below is new, so this entry describes the tool rather than
listing changes against a previous release.

### Added

- **The board.** One row per watched repo showing the most recent pipeline on its branch:
  status, pipeline number, commit, stage bubbles, and when it was last updated and last
  checked. Rows are grouped into sections by GitLab namespace; failed rows name the jobs
  that failed.
- **Stage and job controls.** Expand a stage for its jobs, read a job log with ANSI colours
  preserved and progress-bar spam collapsed, and retry, cancel or start a manual job.
  Starting a manual job asks for confirmation first. The log view follows a job across a
  retry even though its id changes.
- **Row controls.** Check now, retry the pipeline's failed jobs, cancel a running pipeline,
  pause or resume watching, remove from the board.
- **Filtering.** Tabs that count and filter by status, plus a search box and a group
  dropdown.
- **Polling.** Serial sweeps, one repo at a time, on a configurable interval (30s to 15m,
  default 2m). Two request lanes keep the UI responsive mid-sweep. Jobs are cached only
  when the pipeline cannot change. 5 retries with exponential backoff honouring
  `Retry-After`; 401/403 stops polling and shows a banner.
- **Credentials.** Set up in the UI and verified against GitLab before being stored. The
  token goes to the Windows DPAPI store or the macOS Keychain where available, and to the
  database in plain text otherwise, with the UI saying which. It is never logged, never
  returned by the API and never exported.
- **Configuration.** `GITLAB_PAT`, `GITLAB_BASE_URL`, `CI_DECK_PORT` and `CI_DECK_DB`,
  layered per value: inline environment, then env file, then what the UI saved. The UI
  shows where each value came from.
- **CLI.** `--env`, `--db`, `--port`, `--rebuild`, `--help`.
- **Import and export** of the watch list, additive on import, re-resolving by path when
  the list came from a different GitLab instance.
- **Security posture.** Loopback-only binding with no flag to change it, a `Host` check
  against DNS rebinding, cross-site write rejection via `Origin` and `Sec-Fetch-Site`, a
  strict CSP with no inline script, and a stored token that only ever goes to the host it
  was saved for.

[Unreleased]: https://github.com/ivanbaha/ci-deck/compare/v0.1.0-b1...HEAD
[0.1.0-b1]: https://github.com/ivanbaha/ci-deck/releases/tag/v0.1.0-b1
