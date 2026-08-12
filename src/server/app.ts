import { EnvError } from '../config/env.ts';
import { ConfigureError, type Runtime } from '../core/runtime.ts';
import { describeProject, normalizeRepoInput, RepoResolutionError, resolveNewRepo } from '../core/resolver.ts';
import { repoViewFromRecord } from '../core/state.ts';
import { describeError, GitLabRequestError, isAuthError } from '../gitlab/errors.ts';
import { CANCELABLE_JOB_STATUSES } from '../shared/statuses.ts';
import type { ColumnKey, JobView, RepoCandidate, Settings, StageView } from '../shared/types.ts';
import { COLUMN_KEYS } from '../shared/types.ts';
import {
    isNotifyMode,
    isThemePreference,
    parseExportFile,
    parseExportSettings,
    parseExportTags,
    type ExportedRepo,
    type WatchStore,
} from '../store/watch-store.ts';
import type { Assets } from './assets.ts';
import { checkRequestOrigin, type AllowedOrigins } from './guard.ts';
import { eventStream } from './sse.ts';

export interface AppDeps {
    runtime: Runtime;
    watchStore: WatchStore;
    assets: Assets;
    origins: AllowedOrigins;
}

/**
 * The board and the GitLab job logs it renders share an origin with the control
 * API, so the page is pinned to its own assets: no inline script, no third-party
 * anything, and no framing.
 */
const CSP = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
};

/** Well past any real watch list, and short of a file that would hold the server. */
export const MAX_IMPORT_REPOS = 500;

/** What a stage-wide control does, and to which of the stage's jobs. */
export type StageAction = 'retry' | 'cancel' | 'play';

export class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

type Handler = (request: Request & { params?: Record<string, string> }) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers: SECURITY_HEADERS });

function statusFor(error: unknown): number {
    if (error instanceof HttpError) return error.status;
    if (error instanceof RepoResolutionError || error instanceof EnvError) return 400;
    // Unconfigured credentials: the UI reacts by opening the setup panel.
    if (error instanceof ConfigureError) return 409;
    // GitLab refused the token we hold, rather than us failing to reach it.
    if (isAuthError(error)) return 401;
    // Only an upstream failure is a gateway failure. Everything left — a losing
    // side of a race on the watch list, a database that will not write — happened
    // here, and blaming GitLab for it sends the reader to the wrong logs.
    if (error instanceof GitLabRequestError) return 502;
    return 500;
}

/** Wraps a handler with the origin guard and error-to-status mapping. */
function route(deps: AppDeps, handler: Handler): Handler {
    return async (request) => {
        const guard = checkRequestOrigin(request, deps.origins);
        if (!guard.ok) return json({ error: guard.reason }, 403);

        try {
            return await handler(request);
        } catch (error) {
            return json({ error: describeError(error) }, statusFor(error));
        }
    };
}

/**
 * Which of a stage's jobs a stage-wide control acts on.
 *
 * `retry` takes every failed job, allowed to fail or not: a stage is amber
 * precisely because something in it broke, and "retry the stage" that skipped
 * those would leave the amber behind and look like it had done nothing.
 */
export function jobsForStageAction(stage: StageView, action: StageAction): JobView[] {
    if (action === 'retry') return stage.jobs.filter((job) => job.status === 'failed');
    if (action === 'cancel') return stage.jobs.filter((job) => CANCELABLE_JOB_STATUSES.has(job.status));
    return stage.jobs.filter((job) => job.status === 'manual');
}

export function createServeOptions(deps: AppDeps) {
    const { runtime, watchStore, assets } = deps;
    const store = runtime.appStore;

    const params = (request: Request & { params?: Record<string, string> }) => request.params ?? {};

    const requireRepo = (raw: string | undefined) => {
        const id = Number.parseInt(raw ?? '', 10);
        const repo = Number.isInteger(id) ? store.getRepo(id) : undefined;
        if (!repo) throw new HttpError(404, 'That repo is not on the watch list');
        return repo;
    };

    const requireJobId = (raw: string | undefined) => {
        const jobId = Number.parseInt(raw ?? '', 10);
        if (!Number.isInteger(jobId) || jobId <= 0) throw new HttpError(400, 'Invalid job id');
        return jobId;
    };

    const afterAction = async (id: number) => {
        runtime.activePoller.invalidate(id);
        return { repo: await runtime.activePoller.refreshRepo(id) };
    };

    const readJson = async <T>(request: Request): Promise<T> => {
        try {
            return (await request.json()) as T;
        } catch {
            throw new HttpError(400, 'Expected a JSON body');
        }
    };

    const requireBaseUrl = () => {
        const baseUrl = runtime.baseUrl;
        if (!baseUrl) throw new ConfigureError('GitLab credentials are not configured yet');
        return baseUrl;
    };

    /** Applies the store's ordering, which sinks paused repos to the bottom. */
    const applyStoreOrder = () => {
        const baseUrl = runtime.baseUrl;
        if (baseUrl) store.reorder(watchStore.listReposFor(baseUrl).map((record) => record.id));
    };

    /** Ids only transfer within the instance they were resolved against. */
    const addFromEntry = async (entry: ExportedRepo, baseUrl: string) => {
        const reusableId = entry.projectId && (!entry.baseUrl || entry.baseUrl === baseUrl);

        const resolved = reusableId
            ? {
                name: entry.name,
                projectId: entry.projectId!,
                // Through the same normaliser the other branch resolves with, so a
                // file cannot store an absolute URL as a project path — which is
                // what a row's own links are then built from.
                path: entry.path ? normalizeRepoInput(entry.path) || null : null,
                ref: entry.ref,
                group: entry.group,
            }
            : await resolveNewRepo(runtime.client, entry.path || entry.name, {
                ref: entry.ref,
                group: entry.group,
            });

        const record = watchStore.addRepo({
            ...resolved,
            baseUrl,
            ...(isNotifyMode(entry.notify) ? { notify: entry.notify } : {}),
        });
        const tags = entry.tags?.length ? watchStore.setRepoTags(baseUrl, record.id, entry.tags) : [];
        store.addRepo(repoViewFromRecord(record, baseUrl, tags));
        return record;
    };

    const indexResponse = () =>
        new Response(assets.index(), {
            headers: {
                ...SECURITY_HEADERS,
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store',
                'Content-Security-Policy': CSP,
            },
        });

    return {
        routes: {
            '/': route(deps, () => indexResponse()),

            '/assets/:file': route(deps, async (request) => {
                const file = await assets.asset(params(request).file ?? '');
                if (!file) throw new HttpError(404, 'Not found');

                return new Response(file, {
                    headers: { ...SECURITY_HEADERS, 'Cache-Control': 'no-store' },
                });
            }),

            '/api/state': { GET: route(deps, () => json(store.snapshot())) },

            '/api/events': { GET: route(deps, () => eventStream(store)) },

            '/api/credentials': {
                // The token is never returned; only its presence, source and mask.
                PUT: route(deps, async (request) => {
                    const body = await readJson<{ baseUrl?: string; token?: string }>(request);
                    const result = await runtime.configure({
                        baseUrl: body.baseUrl,
                        token: body.token,
                    });
                    return json(result);
                }),
                DELETE: route(deps, async () => {
                    await runtime.forget();
                    return json({ forgotten: true });
                }),
            },

            '/api/settings': {
                PUT: route(deps, async (request) => {
                    const body = await readJson<{
                        pollPeriodSeconds?: number;
                        defaultRef?: string;
                        confirmManualRun?: boolean;
                        notifications?: string;
                        theme?: string;
                        columnWidths?: Record<string, number>;
                    }>(request);

                    const patch: Partial<Settings> = {};

                    if (body.pollPeriodSeconds !== undefined) {
                        if (typeof body.pollPeriodSeconds !== 'number') {
                            throw new HttpError(400, 'pollPeriodSeconds must be a number');
                        }
                        patch.pollPeriodSeconds = watchStore.setPollPeriod(body.pollPeriodSeconds);
                    }

                    // The branch a repo added without one is watched on. It reaches
                    // the board through the add dialog and travels in an export, so
                    // it needs a way in that is not editing the database by hand.
                    if (body.defaultRef !== undefined) {
                        if (typeof body.defaultRef !== 'string' || !body.defaultRef.trim()) {
                            throw new HttpError(400, 'defaultRef must be a branch name');
                        }
                        patch.defaultRef = watchStore.setDefaultRef(body.defaultRef);
                    }

                    if (body.confirmManualRun !== undefined) {
                        if (typeof body.confirmManualRun !== 'boolean') {
                            throw new HttpError(400, 'confirmManualRun must be a boolean');
                        }
                        patch.confirmManualRun = watchStore.setConfirmManualRun(body.confirmManualRun);
                    }

                    if (body.notifications !== undefined) {
                        if (!isNotifyMode(body.notifications)) {
                            throw new HttpError(400, 'notifications must be on, snooze or off');
                        }
                        patch.notifications = watchStore.setNotifications(body.notifications);
                    }

                    if (body.theme !== undefined) {
                        if (!isThemePreference(body.theme)) {
                            throw new HttpError(400, 'theme must be system, dark or light');
                        }
                        patch.theme = watchStore.setTheme(body.theme);
                    }

                    // Kept server-side like every other preference, so the board
                    // looks the same from the second browser you open it in.
                    if (body.columnWidths !== undefined) {
                        const widths = body.columnWidths;
                        if (!widths || typeof widths !== 'object') {
                            throw new HttpError(400, 'columnWidths must be an object of column widths');
                        }
                        const wanted: Partial<Record<ColumnKey, number>> = {};
                        for (const key of COLUMN_KEYS) {
                            const value = widths[key];
                            if (typeof value === 'number') wanted[key] = value;
                        }
                        patch.columnWidths = watchStore.setColumnWidths(wanted);
                    }

                    if (Object.keys(patch).length === 0) {
                        throw new HttpError(400, 'Nothing to change');
                    }

                    const settings = store.setSettings(patch);

                    // Only the interval, and only because the poller works out the
                    // next wait when the last sweep ends: shortening 15m to 30s
                    // would otherwise sit out the rest of the old wait first. The
                    // rest of these settings are about how the board looks and what
                    // it says, and dragging a column is not news about a pipeline.
                    if (patch.pollPeriodSeconds !== undefined && runtime.configured) {
                        runtime.activePoller.trigger();
                    }
                    return json({ settings });
                }),
            },

            /**
             * The rows the board is currently showing. The sweep visits these
             * first and then everything else, so narrowing the view shortens the
             * wait for what is on screen without quietly deciding which repos are
             * still allowed to notify you.
             */
            '/api/focus': {
                PUT: route(deps, async (request) => {
                    const body = await readJson<{ repos?: number[] }>(request);
                    if (!Array.isArray(body.repos)) {
                        throw new HttpError(400, 'repos must be an array of ids');
                    }
                    store.setFocus(body.repos.filter((id) => Number.isInteger(id)));
                    return json({ focused: body.repos.length });
                }),
            },

            /**
             * What the add dialog asks before anything is added: does this repo
             * exist, and which branches can be watched on it.
             */
            '/api/resolve': {
                GET: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const input = new URL(request.url).searchParams.get('repo')?.trim();
                    if (!input) throw new HttpError(400, 'repo is required');

                    const { project, branches, truncated } = await describeProject(runtime.client, input);
                    const candidate: RepoCandidate = {
                        name: project.name,
                        path: project.path_with_namespace,
                        projectId: project.id,
                        webUrl: project.web_url,
                        defaultBranch: project.default_branch,
                        branches,
                        branchesTruncated: truncated,
                        watchedRefs: watchStore.refsFor(baseUrl, project.id),
                    };
                    return json({ candidate });
                }),
            },

            '/api/tags': {
                POST: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const body = await readJson<{ name?: string }>(request);
                    const name = body.name?.trim();
                    if (!name) throw new HttpError(400, 'A tag needs a name');
                    if (watchStore.hasTag(baseUrl, name)) {
                        throw new HttpError(409, `${name} already exists`);
                    }

                    watchStore.createTag(baseUrl, name);
                    runtime.refreshTags();
                    return json({ tags: store.getTags() }, 201);
                }),
            },

            '/api/tags/:name': {
                PUT: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const from = params(request).name!;
                    const body = await readJson<{ name?: string }>(request);
                    const to = body.name?.trim();
                    if (!to) throw new HttpError(400, 'A tag needs a name');

                    try {
                        if (!watchStore.renameTag(baseUrl, from, to)) {
                            throw new HttpError(404, `${from} is not a tag`);
                        }
                    } catch (error) {
                        if (error instanceof HttpError) throw error;
                        throw new HttpError(409, describeError(error));
                    }

                    runtime.syncTags(baseUrl);
                    return json({ tags: store.getTags() });
                }),

                DELETE: route(deps, (request) => {
                    const baseUrl = requireBaseUrl();
                    const name = params(request).name!;
                    if (!watchStore.deleteTag(baseUrl, name)) {
                        throw new HttpError(404, `${name} is not a tag`);
                    }

                    runtime.syncTags(baseUrl);
                    return json({ tags: store.getTags() });
                }),
            },

            // The bulk direction: one call sets a tag's whole membership, which is
            // the difference between seven passes and eighty dialogs.
            '/api/tags/:name/repos': {
                PUT: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const name = params(request).name!;
                    const body = await readJson<{ repos?: number[] }>(request);
                    if (!Array.isArray(body.repos)) {
                        throw new HttpError(400, 'repos must be an array of ids');
                    }
                    if (!watchStore.hasTag(baseUrl, name)) {
                        throw new HttpError(404, `${name} is not a tag`);
                    }

                    const applied = watchStore.setTagRepos(
                        baseUrl,
                        name,
                        body.repos.filter((id) => Number.isInteger(id)),
                    );
                    runtime.syncTags(baseUrl);
                    return json({ tag: name, repos: applied, tags: store.getTags() });
                }),
            },

            '/api/repos/:id/tags': {
                PUT: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const repo = requireRepo(params(request).id);
                    const body = await readJson<{ tags?: string[] }>(request);
                    if (!Array.isArray(body.tags)) {
                        throw new HttpError(400, 'tags must be an array of names');
                    }

                    const applied = watchStore.setRepoTags(baseUrl, repo.id, body.tags);
                    store.patchRepo(repo.id, { tags: applied });
                    runtime.refreshTags();
                    return json({ tags: applied, allTags: store.getTags() });
                }),
            },

            '/api/sweep': {
                POST: route(deps, () => {
                    // `activePoller` only answers for whether one exists. One that
                    // stopped on a rejected token is still there and still ignores
                    // `trigger`, so saying "started" would be a straight untruth.
                    if (!runtime.configured) {
                        throw new ConfigureError('GitLab credentials are not configured yet');
                    }
                    if (!runtime.polling) {
                        throw new HttpError(
                            409,
                            'Polling has stopped — reconnect to GitLab before asking for a sweep',
                        );
                    }
                    runtime.activePoller.trigger();
                    return json({ started: true });
                }),
            },

            '/api/repos': {
                POST: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const body = await readJson<{ repo?: string; ref?: string }>(request);
                    const input = body.repo?.trim();
                    if (!input) throw new HttpError(400, 'repo is required');

                    const resolved = await resolveNewRepo(runtime.client, input, {
                        ref: body.ref?.trim() || undefined,
                    });
                    const ref = resolved.ref?.trim() || watchStore.settings.defaultRef;
                    if (watchStore.findRepo(baseUrl, resolved.name, ref)) {
                        throw new HttpError(409, `${resolved.name} is already watched on ${ref}`);
                    }

                    const record = watchStore.addRepo({ ...resolved, ref, baseUrl });
                    store.addRepo(repoViewFromRecord(record, baseUrl));
                    applyStoreOrder();
                    const repo = await runtime.activePoller.refreshRepo(record.id);
                    return json({ repo }, 201);
                }),
            },

            '/api/repos/:id': {
                DELETE: route(deps, (request) => {
                    const repo = requireRepo(params(request).id);
                    watchStore.removeRepo(repo.id);
                    if (runtime.configured) runtime.activePoller.invalidate(repo.id);
                    store.removeRepo(repo.id);
                    return json({ removed: repo.id });
                }),
            },

            '/api/repos/:id/refresh': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    return json(await afterAction(repo.id));
                }),
            },

            '/api/repos/:id/watch': {
                PUT: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    const body = await readJson<{ watched?: boolean }>(request);
                    if (typeof body.watched !== 'boolean') {
                        throw new HttpError(400, 'watched must be a boolean');
                    }

                    watchStore.setWatched(repo.id, body.watched);
                    store.patchRepo(repo.id, { watched: body.watched });
                    applyStoreOrder();

                    // Resuming should show fresh data at once; pausing changes nothing else.
                    if (body.watched && runtime.configured) {
                        return json({ watched: true, repo: await runtime.activePoller.refreshRepo(repo.id) });
                    }
                    return json({ watched: body.watched });
                }),
            },

            '/api/repos/:id/notify': {
                PUT: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    const body = await readJson<{ notify?: string }>(request);
                    if (!isNotifyMode(body.notify)) {
                        throw new HttpError(400, 'notify must be on, snooze or off');
                    }

                    watchStore.setNotify(repo.id, body.notify);
                    store.patchRepo(repo.id, { notify: body.notify });
                    return json({ notify: body.notify });
                }),
            },

            '/api/repos/:id/jobs/:jobId/log': {
                GET: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    const log = await runtime.client.getJobLog(
                        repo.projectId,
                        requireJobId(params(request).jobId),
                    );
                    // A job trace is whatever a runner printed: nosniff keeps the
                    // browser from deciding it is markup.
                    return new Response(log, {
                        headers: {
                            ...SECURITY_HEADERS,
                            'Content-Type': 'text/plain; charset=utf-8',
                            'Cache-Control': 'no-store',
                        },
                    });
                }),
            },

            '/api/repos/:id/jobs/:jobId/retry': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    await runtime.client.retryJob(repo.projectId, requireJobId(params(request).jobId));
                    return json(await afterAction(repo.id));
                }),
            },

            '/api/repos/:id/jobs/:jobId/cancel': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    await runtime.client.cancelJob(repo.projectId, requireJobId(params(request).jobId));
                    return json(await afterAction(repo.id));
                }),
            },

            '/api/repos/:id/jobs/:jobId/play': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    await runtime.client.playJob(repo.projectId, requireJobId(params(request).jobId));
                    return json(await afterAction(repo.id));
                }),
            },

            /**
             * One control acting on a whole stage. The alternative was the browser
             * firing a request per job and refreshing the row after each, which on
             * a fanned-out test stage is a dozen round trips and a dozen redraws
             * for what the user thinks of as one action.
             *
             * The stage travels in the body rather than the path: a stage name is
             * free-form and routinely carries a slash.
             */
            '/api/repos/:id/stage/:action': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    const action = params(request).action as StageAction;
                    if (action !== 'retry' && action !== 'cancel' && action !== 'play') {
                        throw new HttpError(404, 'Not found');
                    }

                    const body = await readJson<{ stage?: string }>(request);
                    const stage = repo.stages.find((entry) => entry.name === body.stage);
                    if (!stage) throw new HttpError(404, `${repo.name} has no stage called ${body.stage}`);

                    const jobs = jobsForStageAction(stage, action);
                    if (jobs.length === 0) {
                        const verb = { retry: 'retried', cancel: 'cancelled', play: 'started' }[action];
                        throw new HttpError(409, `Nothing in ${stage.name} can be ${verb}`);
                    }

                    const act = (jobId: number) =>
                        action === 'retry'
                            ? runtime.client.retryJob(repo.projectId, jobId)
                            : action === 'cancel'
                                ? runtime.client.cancelJob(repo.projectId, jobId)
                                : runtime.client.playJob(repo.projectId, jobId);

                    // Every job is attempted even when one of them fails: a stage
                    // where the first retry loses a race should still restart the
                    // rest, and the count says how it went.
                    const results = await Promise.allSettled(jobs.map((job) => act(job.id)));
                    const failures = results.filter((result) => result.status === 'rejected');
                    if (failures.length === results.length) {
                        throw new HttpError(
                            502,
                            describeError((failures[0] as PromiseRejectedResult).reason),
                        );
                    }

                    return json({
                        ...(await afterAction(repo.id)),
                        stage: stage.name,
                        acted: results.length - failures.length,
                        failed: failures.length,
                    });
                }),
            },

            '/api/repos/:id/pipeline/retry': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    if (!repo.pipeline) throw new HttpError(409, `${repo.name} has no pipeline to retry`);
                    await runtime.client.retryPipeline(repo.projectId, repo.pipeline.id);
                    return json(await afterAction(repo.id));
                }),
            },

            '/api/repos/:id/pipeline/cancel': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).id);
                    if (!repo.pipeline) throw new HttpError(409, `${repo.name} has no pipeline to cancel`);
                    await runtime.client.cancelPipeline(repo.projectId, repo.pipeline.id);
                    return json(await afterAction(repo.id));
                }),
            },

            '/api/export': {
                GET: route(deps, () =>
                    new Response(`${JSON.stringify(watchStore.exportList(requireBaseUrl()), null, 2)}\n`, {
                        headers: {
                            ...SECURITY_HEADERS,
                            'Content-Type': 'application/json; charset=utf-8',
                            'Content-Disposition': 'attachment; filename="ci-deck-watchlist.json"',
                        },
                    }),
                ),
            },

            '/api/import': {
                POST: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const payload = await readJson<unknown>(request);
                    const entries = parseExportFile(payload);
                    if (entries.length === 0) throw new HttpError(400, 'No repos found in the file');
                    // Each unknown entry costs a GitLab round trip, walked in order
                    // while this request is held open. A file bigger than any real
                    // watch list is a mistake worth naming rather than sitting through.
                    if (entries.length > MAX_IMPORT_REPOS) {
                        throw new HttpError(
                            400,
                            `That file has ${entries.length} repos; ${MAX_IMPORT_REPOS} is the most CI Deck imports at once`,
                        );
                    }

                    // Tags first, so an empty one in the file survives even when
                    // every repo carrying it was already on the board.
                    for (const tag of parseExportTags(payload)) watchStore.createTag(baseUrl, tag);

                    // An export carries the board's settings, so an import applies
                    // them — a file that says nothing about them changes nothing.
                    // The dialog names them before any of this runs, because a poll
                    // interval that moves on its own is a mystery, not a feature.
                    const fromFile = parseExportSettings(payload);
                    const settingsPatch: Partial<Settings> = {
                        ...(fromFile.pollPeriodSeconds !== undefined
                            ? { pollPeriodSeconds: watchStore.setPollPeriod(fromFile.pollPeriodSeconds) }
                            : {}),
                        ...(fromFile.defaultRef !== undefined
                            ? { defaultRef: watchStore.setDefaultRef(fromFile.defaultRef) }
                            : {}),
                    };

                    const added: string[] = [];
                    const tagged: string[] = [];
                    const skipped: { repo: string; reason: string }[] = [];
                    // The same "repo · branch" the board and the import dialog use,
                    // because a row is that pair and a name alone no longer names one.
                    const label = (entry: ExportedRepo, ref: string) => `${entry.name} · ${ref}`;

                    for (const entry of entries) {
                        const ref = entry.ref?.trim() || watchStore.settings.defaultRef;
                        const existing = watchStore.findRepo(baseUrl, entry.name, ref);

                        if (existing) {
                            // A row already watched is left alone, but its tags are
                            // merged: that is what makes a file useful for sharing a
                            // tag layout with someone whose board already has the repos.
                            if (entry.tags?.length) {
                                const applied = watchStore.addRepoTags(baseUrl, existing.id, entry.tags);
                                store.patchRepo(existing.id, { tags: applied });
                                tagged.push(label(entry, ref));
                                continue;
                            }
                            skipped.push({
                                repo: label(entry, ref),
                                reason: `${entry.name} is already watched on ${ref}`,
                            });
                            continue;
                        }
                        try {
                            const record = await addFromEntry({ ...entry, ref }, baseUrl);
                            added.push(label(entry, record.ref));
                        } catch (error) {
                            skipped.push({ repo: label(entry, ref), reason: describeError(error) });
                        }
                    }

                    runtime.refreshTags();
                    applyStoreOrder();
                    const settings = Object.keys(settingsPatch).length > 0
                        ? store.setSettings(settingsPatch)
                        : store.getSettings();

                    if (added.length > 0 && runtime.polling) runtime.activePoller.trigger();
                    return json({ added, tagged, skipped, settings });
                }),
            },
        },

        // Unknown /api paths are errors; everything else serves the app shell.
        fetch: route(deps, (request) => {
            const path = new URL(request.url).pathname;
            if (path.startsWith('/api/')) return json({ error: 'Not found' }, 404);
            return indexResponse();
        }),

        error: (error: Error) => json({ error: describeError(error) }, 500),
    };
}
