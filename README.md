# CI Deck

One page showing the pipeline of every repo you care about, with the GitLab controls you
actually need: expand a stage, read a job log, retry, cancel or start a manual job.

Runs locally on [Bun](https://bun.sh) with **no runtime dependencies** — Bun's own HTTP
server, SQLite and bundler do the work. Talks to GitLab's REST API with your personal
access token.

```bash
bun install
bun run start
# → http://127.0.0.1:8787
```

No configuration files, no environment variables. On first run the board asks for your
GitLab URL and a personal access token, checks them against GitLab, and remembers them in
your operating system's credential store.

Then add repos with **Add repo** — by name, by `group/subgroup/repo` path, or by pasting
any GitLab project URL.

## Requirements

- Bun 1.2.3 or newer — that is where `Bun.serve`'s router landed. Nothing else.
- A GitLab personal access token with the **`api`** scope. `read_api` is not enough,
  because CI Deck retries and cancels jobs.

## Installing it globally

```bash
bun add -g ci-deck   # the `ci-deck` command
bunx ci-deck         # or run it without installing
```

From a checkout, to get the command without publishing anything:

```bash
bun link           # once, from this directory
```

That puts the binary in Bun's global bin directory (`~/.bun/bin`). If it is not on your
`PATH`, either add it or call the binary directly:

```bash
~/.bun/bin/ci-deck            # macOS / Linux
~/.bun/bin/ci-deck.exe        # Windows
```

The database lives in your per-user data directory, so a global install works from any
working directory.

## Using the board

Each row is one repo's most recent pipeline on its branch: status badge, pipeline number,
commit, the stage bubbles, and when it was last updated and last checked. Rows are grouped
into sections by GitLab namespace, each section counting its repos and its failures. The
top bar, the column header and the current section stay put as you scroll.

A red row names the jobs that failed next to the commit, so the usual question does not
cost a click.

**Stages and jobs.** Click a stage bubble for the jobs in that stage. Each job shows its
status and duration, and carries the one control that applies to it:

| Job status | Control |
| --- | --- |
| running, pending, created | cancel |
| manual | start — confirmed first, since manual jobs often deploy |
| failed, success, canceled, skipped | retry |

Click the job itself to read its log: ANSI colours preserved, progress-bar spam collapsed,
and auto-following while the job is still running. Retry and cancel are available there
too, and the view keeps up with the job across a retry even though its id changes.

**Row controls**, on the right of each row:

| Icon | Action |
| --- | --- |
| ⟳ | check this repo now, ignoring the sweep and its cache |
| ↺ | retry the pipeline's failed jobs |
| 🚫 | cancel the running pipeline (confirmed) |
| 👁 / 👁̶ | pause or resume watching |
| 🗑 | remove from the board (confirmed) |

**Watching, paused, removed.** A newly added repo is watched. Pausing keeps it on the
board but takes it out of the periodic sweep, so it costs nothing and shows its last known
state; paused rows sink to the bottom of their section and can still be checked with the ⟳
button. Removing takes it off the board entirely.

**Filtering.** The tabs count and filter by status (failed, running, passed, other), and
the search box and group dropdown narrow the list further. The search box takes a
comma-separated list, which is an OR — `crud, ledger` shows both. A section disappears
when nothing in it matches. Groups come from the GitLab namespace each repo sits in.

**Tags.** *Not switched on yet.* Repos can carry overlapping, hand-made labels —
`lib`, `backs` and `CRUDs` at once — which filter the board across namespaces and can
limit the sweep to what you are looking at. The store, the API and the export format
already carry them; the interface is still being worked out, so it is off by default.
Set `CI_DECK_TAGS=1` to try it, and expect it to change.

**Sweeping.** Everything about the periodic check sits together on the right of the
toolbar, directly above the progress bar it drives: how long the last sweep took and when
the next one is due, the interval — 30s, 60s, 2m, 5m, 10m or 15m, applied the moment you
pick one, default 2 minutes — and a button to check every repo right now.

**The connection.** The button in the top bar is both the status and the way to change it:
it shows who you are connected as and to which host, turns amber when the instance cannot
be reached and red when GitLab rejects the token. Clicking it opens the credentials panel.

## Configuration

Everything can be set in the UI, so the table below is optional. Values are merged **per
value**, most explicit first:

```txt
inline (GITLAB_PAT=… ci-deck)  →  env file  →  what the UI saved
```

| Variable | Description |
| --- | --- |
| `GITLAB_PAT` | personal access token, scope `api` |
| `GITLAB_BASE_URL` | instance root, e.g. `https://gitlab.com/` |
| `CI_DECK_PORT` | HTTP port, default `8787`, overridden by `--port` |
| `CI_DECK_DB` | database path, overridden by `--db` |
| `CI_DECK_TAGS` | `1` to switch on the unfinished tag interface |

The UI shows where each value came from and will not let you edit one the environment is
dictating — otherwise a saved value would be silently ignored. A token supplied through
the environment is never written to the database.

Credentials are always verified against GitLab before being stored, so an accepted form
means a working board. If they are missing or rejected, CI Deck still starts and the UI
opens a setup panel with the reason; it does not exit. See
[`example.env`](./example.env) if you prefer files.

Note that Bun applies `./.env` to the process itself before CI Deck runs. CI Deck reads
the env files again to work out where each value came from, so an explicit `--env` file
still outranks `./.env`, and only variables no file explains count as inline.

## CLI

```txt
ci-deck [options]

--env <path>      env file to read, if present (default: ./.env)
--db <path>       SQLite database (default: per-user data directory)
--port <number>   HTTP port (default: 8787)
--rebuild         rebuild the browser bundle before starting
-h, --help
```

## Where state lives

The watch list, settings and a reference to your token are kept in SQLite, in the per-user
data directory:

| OS | Path |
| --- | --- |
| Windows | `%LOCALAPPDATA%\ci-deck\ci-deck.db` |
| macOS | `~/Library/Application Support/ci-deck/ci-deck.db` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/ci-deck/ci-deck.db` |

Override with `--db ./ci-deck.db` to keep a project-local list, e.g. one per team.

The token itself is not in that file wherever the platform offers something better:

| Platform | Where the token goes |
| --- | --- |
| Windows | DPAPI blob in the database, bound to your user and machine |
| macOS | Keychain item, service `ci-deck` |
| Other | the database in plain text, and the UI says so |

A DPAPI blob only decrypts for the user and machine that wrote it, so a copied database
asks for the token again rather than failing mysteriously.

Each repo records the instance it was resolved against, because GitLab project ids are
per-instance. Point CI Deck at a different host and you get that host's list, not a board
of rows pointing at unrelated projects.

## Sharing a watch list

Both live behind the caret next to **Add repo**. **Export** downloads the list; **Import**
opens a dialog you can drop a file onto or browse for, and which offers a template so you
are not guessing at the format.

The dialog reads the file with the same parser the server will use and says what is about
to happen — how many repos it would add, how many are already on the board — before
anything is sent. Import is additive, repos already watched are left alone, and every entry
it skipped is listed with its reason. The paused state travels with the list. Credentials
never do.

Exports record the instance each project id came from. Importing a list from a different
host re-resolves every repo by path instead of trusting ids that would point elsewhere.

Tags travel with the list even while the interface is off, including ones nothing carries
yet. A repo already on the board is not re-added, but the file's tags are merged onto it.

Hand-written files work too — an array of names is enough, and entries may give just a
`path`:

```json
{
  "tags": ["backs"],
  "repos": ["my-service", { "path": "group/team/other-service", "ref": "develop", "tags": ["backs"] }]
}
```

## How polling behaves

- **Serial sweeps.** One repo at a time, ~200ms apart. A sweep never overlaps the next
  one; if it overruns the interval, the following sweep starts right after it. Around 48
  repos take roughly 50s.
- **Two request lanes.** The sweep runs on a serialised lane; everything you trigger — job
  log, retry, cancel, per-row check — runs on a separate lane, so the UI stays responsive
  mid-sweep.
- **Paused repos are skipped**, and are not counted in sweep progress.
- **Tag scoping skips the rest**, when tags are switched on: a sweep then walks only the
  repos carrying a selected tag, so a watch list far larger than one pass can cover stays
  useful.
- **Jobs are cached only when they cannot change.** A finished pipeline costs one request
  per sweep; anything running, pending or manual has its jobs refetched every time,
  because GitLab does not always bump the pipeline's `updated_at` when a single job
  changes state.
- **Retries.** 5 attempts by default with 1/2/4/8/16s backoff, honouring `Retry-After`.
  A 401/403 is never retried: polling stops and the UI shows a banner. Other 4xx are not
  retried either. A repo that keeps failing is marked `Error` and retried next sweep.
- **Project ids are resolved once**, when a repo is added, so sweeps never spend a request
  looking them up.

## Security

Read this before sharing the tool.

- **The server holds your token.** It is never logged, never returned by the API — the UI
  only ever sees a mask like `glpat-…4f2a` plus where it is stored — and never included in
  an export. Anyone who can reach the HTTP port can retry and cancel pipelines as you.
- **Stored, not encrypted-by-magic.** On Windows and macOS the token goes to the OS
  credential store. Everywhere else it sits in the database in plain text and the UI tells
  you so, because encrypting it with a key the app can derive on its own would be
  obfuscation, not protection. The data directory is `0700` where file modes apply.
- **Loopback only.** It binds to `127.0.0.1` and there is no flag to change that. There is
  no authentication, so exposing it on a shared interface would hand your GitLab access to
  the network.
- **Cross-site writes are blocked.** Loopback binding does not stop a web page you have
  open from posting to `127.0.0.1`, so `POST`/`PUT`/`PATCH`/`DELETE` are rejected when the
  request carries a foreign `Origin` or a cross-site `Sec-Fetch-Site`. Header-less clients
  such as `curl` still work.
- **Only its own address is answered.** A site whose DNS is rebound to `127.0.0.1` looks
  same-origin to the browser, which sends no `Origin` at all — so every request must also
  be addressed to `127.0.0.1`, `localhost` or `[::1]` on the right port. Anything else is
  rejected before it reaches a handler, whatever the method.
- **The saved token only goes to the host it was saved for.** Changing the GitLab URL asks
  for that instance's token instead of forwarding the stored one, so no single request can
  make CI Deck present your PAT somewhere new.
- **Manual jobs are gated.** Starting one is a deploy in many pipelines, so it always asks
  for confirmation first.
- **Token hygiene.** Use a short expiry and the narrowest scope that works (`api`). Keep
  `.env` out of version control — the shipped `.gitignore` already does that.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/state` | full board snapshot, including credential provenance |
| `GET` | `/api/events` | SSE stream of board updates |
| `PUT` | `/api/credentials` | `{ baseUrl?, token? }` — verified, then stored |
| `DELETE` | `/api/credentials` | forget the stored token, keep the list |
| `PUT` | `/api/settings` | `{ pollPeriodSeconds?, activeTags?, scopeSweepToTags? }` |
| `POST` | `/api/tags` | `{ name }` — create |
| `PUT` \| `DELETE` | `/api/tags/:name` | rename with `{ name }`, or delete |
| `PUT` | `/api/tags/:name/repos` | `{ repos }` — set a tag's whole membership |
| `POST` | `/api/sweep` | start a sweep now |
| `POST` | `/api/repos` | `{ repo, ref? }` — name, path or pasted GitLab URL |
| `PUT` | `/api/repos/:name/tags` | `{ tags }` — replace one repo's tags |
| `DELETE` | `/api/repos/:name` | remove from the board |
| `PUT` | `/api/repos/:name/watch` | `{ watched }` — pause or resume |
| `POST` | `/api/repos/:name/refresh` | check this repo now |
| `GET` | `/api/repos/:name/jobs/:jobId/log` | raw job trace |
| `POST` | `/api/repos/:name/jobs/:jobId/retry` \| `/cancel` \| `/play` | job actions |
| `POST` | `/api/repos/:name/pipeline/retry` \| `/cancel` | pipeline actions |
| `GET` | `/api/export` | download the list |
| `POST` | `/api/import` | add repos from an uploaded list |

## Contributing

Layout of the source, the everyday commands, the icon rules and how a release is cut are in
[`CONTRIBUTING.md`](./CONTRIBUTING.md). Notable changes are recorded in
[`CHANGELOG.md`](./CHANGELOG.md).

## Credits

Most icons and the logo are from [SVG Repo](https://www.svgrepo.com) (public domain "Mixer
Tools" set).
All of them are embedded as bare paths in `web/icons.ts` and `web/favicon.svg`, so they
inherit colour and need no network request.

## License

Copyright 2026 Ivan Baha.

Licensed under the Apache License, Version 2.0. See [`LICENSE`](./LICENSE) for the full
text.

Found a security problem? [`SECURITY.md`](./SECURITY.md) says where to send it.
