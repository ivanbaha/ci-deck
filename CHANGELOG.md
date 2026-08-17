# Changelog

All notable changes to CI Deck are recorded here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0.0, minor
versions may still change behaviour.

## [Unreleased]

## [0.2.1] — 2026-08-17

Image-only release. Nothing in CI Deck itself changed, so the npm package and the standalone
binaries are `0.2.0` with a new version number.

### Security

- **The image ships patched Alpine packages.** It builds on `oven/bun:1.3-alpine`, which is
  rebuilt on its own schedule and had been carrying an openssl a month behind — fifteen
  CVEs, the worst of them a CMS authentication bypass rated 9.1. The build now upgrades the
  base image's packages before installing anything, so a published image carries what Alpine
  had on the day it was built rather than on the day the base image was. Nothing in the
  package or the binaries was ever affected: both run against the openssl on your machine.
- **The image is scanned before it is pushed.** CI scans every build and the release scans
  again, on the layers about to ship, before the job signs in to either registry. Findings
  Alpine has not fixed are excluded on purpose — see [SECURITY.md](SECURITY.md) for the one
  that is currently reported and why it cannot be reached here.

### Changed

- **Dependabot watches the base image.** `apk upgrade` covers Alpine's own packages, but Bun
  is a binary baked into the image rather than an apk package, so moving off a stale tag is
  the one thing the build cannot do for itself.

## [0.2.0] — 2026-08-12

### Added

- **A repo can be watched on several branches at once.** A row is now a repo *and* a
  branch, so `main` and a release branch are two rows, filed side by side under one name.
  The add dialog looks the repo up while you type and offers the branches it actually has,
  so a name that is not there is said before you commit to it rather than after. A branch
  that is deleted on GitLab strikes its row through, since nothing on it can change again.
- **Notifications when a pipeline finishes**, with a short chime and the names of whatever
  failed. Every row has its own setting — notify, notify silently, or say nothing, on the
  bell beside the eye — under a global one in Configuration that acts as a ceiling over
  them. The board only announces pipelines it watched go from running to finished, so a
  restart does not replay yesterday. Two limits are inherent: it needs a board tab open,
  and no browser will play a sound until you have clicked the page once.
- **A configuration window**, behind the gear in the top bar. The GitLab connection and
  where its credentials came from, the sweep interval and default branch, whether starting
  a manual job asks first, the global notification setting, the theme, and the tag manager
  — all stored in the database beside the watch list.
- **A light theme**, following the system by default and settable either way. Every colour
  is one token holding both values, so the two cannot drift apart. The job log stays dark
  in both: a runner's ANSI colours are chosen against black.
- **One control per stage**, in the stage popover, applying to every job in it at once —
  retry if anything failed, otherwise cancel if anything is still going, otherwise start if
  anything is waiting. It is one request rather than one per job.
- **Stage bubbles now mark what their status had to bury.** A dashed halo for a stage that
  also holds a manual job, and an amber dot for one where something failed and was allowed
  to. A stage with a manual job used to call itself manual and show no sign of the failure
  beside it.
- **Resizable columns**, dragged from the header or nudged with the arrow keys, stored with
  everything else so the board looks the same in the next browser you open it in. A divider
  trades width between its two neighbours and the board never changes width doing it, so
  nothing moves except the line under the pointer.
- **The board's filters live in the URL** — tab, group, search and tags. A reload keeps
  them, the back button undoes them, and a filtered board is something you can send to
  someone.
- **Copy the raw job output** from the log viewer, escapes and all: a log pasted into an
  issue should be the log, not the viewer's reading of it.
- **Tags are on for everyone.** The interface has settled, so `CI_DECK_TAGS` is gone and
  the manager has moved into Configuration.
- **The default branch is settable**, through `PUT /api/settings` and through an imported
  list. It decides the branch a repo added without one is watched on, it travels in an
  export, and until now nothing but editing the database could change it.
- **An import applies the settings the file carries**, and the dialog names them before you
  press the button — a refresh interval that moves on its own is a mystery, not a feature.
  A file that says nothing about them changes nothing.
- **A tag has a description and a colour.** Both optional, both set in one form behind the
  **+** or the pencil in Configuration → Tags, from ten swatches, a colour well or a hex
  code, with a live preview of the chip it will produce. A coloured tag wears it wherever
  it appears: quiet on a row you are not looking at, and solid in the toolbar while it is
  filtering — in white or near-black text, whichever the colour can actually carry.
- **Ticking a repo in the tag manager saves it.** The Apply button is gone, along with the
  pane you could close having changed nothing you thought you had changed. Writes are
  queued one at a time, since each one sends the tag's whole membership.
- **Tags moved into the toolbar**, beside the search and group filters rather than on a row
  of their own. The chips size themselves: full size on one line where they fit, smaller
  over two where they do not, remeasured whenever the bar's width changes.
- **A tooltip of the board's own**, replacing every `title` attribute in it. It arrives
  without the second of dead air, holds more than one line — the whole list of failed jobs
  rather than the first and a count — and reaches a disabled control, which a mouse event
  cannot.
- **Test a connection without saving it.** The credentials panel gained a **Test** button
  and the server a `POST /api/credentials/test`: the same probe the save runs, storing
  nothing, re-pointing nothing and restarting nothing. It refuses in exactly the same
  places the save does, so it is not a way around the rule that a stored token is only ever
  sent to the host it was stored for.

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

### Security

- **An export carried every instance's repos, not the one it was taken from.** A board
  watching an internal GitLab as well as a public one put the internal host and the paths of
  everything on it into a file exported from the other — and an export exists to be shared.
  It is now scoped the way its tags always were.
- **A watch list could point a row somewhere that is not GitLab.** An imported entry's
  `path` was stored as given, and a row's links are built from it, so an absolute URL in a
  file put an attacker's link under a repo's own name. Paths now go through the same
  normaliser used when a repo is added by hand, and a stored path that does not resolve to
  somewhere on the instance renders as a row with no link at all.
- **The token is no longer put in the process environment.** It is resolved from the
  configuration layers and never read back off `process.env`, so exporting it only made it
  readable in `/proc/<pid>/environ` and inheritable by the credential-store helpers this
  process spawns. An env file now exports the `CI_DECK_*` variables only, and a token Bun
  had already loaded from `./.env` is dropped once it has been read.
- **Every action in the release workflow is pinned to a commit.** That job mints an OIDC
  token npm and GHCR accept as this repository, and a tag can be repointed.

### Changed

- **Rows are addressed by an integer id rather than by name**, throughout the API: a name
  no longer picks out one row now that a repo can be watched on several branches, and it
  was never unique across instances either. The database is rebuilt on first start —
  `repos` keyed by `id` with `UNIQUE(base_url, name, ref)`, and tag memberships carried
  onto the new keys. Nothing is lost, but the routes moved from `/api/repos/:name` to
  `/api/repos/:id`.
- **The export format is version 4.** 3 added a per-row notification setting and treated
  the branch as part of a row's identity; 4 gives a tag its description and colour, so the
  top-level `tags` list holds objects rather than bare names. Older files still import — a
  list of names reads as tags with neither field, and an entry that names no branch means
  the board's default one, which is what it always meant. An import fills in a tag's blanks
  and never repaints one this board has already given a colour to.
- **Tags are assigned in two places, and a row is not one of them.** The invisible control
  on a row that opened a per-repo tag dialog is gone, along with the dialog; a row's chips
  now say what it carries and nothing more. Tags are applied as a repo is added, or under
  Configuration → Tags, which is also where they are made — the Add repo dialog offers the
  tags that exist rather than creating one from whatever was typed.
- **The branch sits beside the repo name**, leaving the line under it to the tags. Both
  clip, but the branch gives up room three times faster, and the whole ref is a hover away.
- **Why a row is red moved onto its status badge.** The `lint +8 failed` text beside the
  commit is now a hover on the badge listing every failed job by name, which the row had no
  width for.
- **A warning outranks a manual job** when a stage's status is worked out. Something did
  fail there, and a stage that also held a manual job was calling itself manual and showing
  no sign of the failure at all.
- **Filtering the board no longer narrows the sweep.** The tag filter used to be able to
  limit what was polled; the sweep now covers every watched row whatever is on screen, and
  simply visits the visible ones first. A filter that decided which repos still get checked
  also decided which ones could still tell you they broke.
- **The row controls are less dim.** At 0.62 opacity they read as "there is nothing here"
  rather than "this is not the point".

### Removed

- `CI_DECK_TAGS`, along with the settings behind the old tag-scoped sweep. Tags are on for
  everyone, and the sweep no longer needs to know about them.

### Fixed

- **The Add repo dialog opened empty.** Its tag input's `list` attribute was being set as a
  property — `HTMLInputElement.list` is a getter, and a module runs in strict mode, so the
  assignment threw between opening the dialog and filling it. The element factory now sets
  an attribute wherever there is no property to set, which also fixes labels that were
  never tied to their inputs and a log view that was never focusable.
- Asking for a sweep after GitLab rejected the token reported that one had started. Polling
  stops for good in that state and cannot be restarted without new credentials, so the
  request is now refused and says why. `/api/state` no longer reports such a board as
  polling either.
- A confirmation raised from inside a dialog closed the dialog that asked for it — deleting
  a tag took the tag manager with it, and the answer was written back into a page that was
  no longer there. Dialogs now stack, and Escape closes only the innermost.
- Tab could walk out of a dialog and into the board behind it, including out of the setup
  panel a board with no credentials cannot get past.
- A failure of CI Deck's own was reported as `502 Bad Gateway`, which blames GitLab for it.
  Only an upstream failure is a gateway failure now; everything else is a 500.
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

[Unreleased]: https://github.com/ivanbaha/ci-deck/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/ivanbaha/ci-deck/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/ivanbaha/ci-deck/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ivanbaha/ci-deck/releases/tag/v0.1.0
[0.1.0-b1]: https://github.com/ivanbaha/ci-deck/releases/tag/v0.1.0-b1
