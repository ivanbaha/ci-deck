import { EnvError } from '../config/env.ts';
import { ConfigureError, type Runtime } from '../core/runtime.ts';
import { RepoResolutionError, resolveNewRepo } from '../core/resolver.ts';
import { repoViewFromRecord } from '../core/state.ts';
import { describeError, isAuthError } from '../gitlab/errors.ts';
import type { Settings } from '../shared/types.ts';
import { parseExportFile, parseExportTags, type ExportedRepo, type WatchStore } from '../store/watch-store.ts';
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
    return 502;
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

export function createServeOptions(deps: AppDeps) {
    const { runtime, watchStore, assets } = deps;
    const store = runtime.appStore;

    const params = (request: Request & { params?: Record<string, string> }) => request.params ?? {};

    const requireRepo = (name: string | undefined) => {
        const repo = name ? store.getRepo(name) : undefined;
        if (!repo) throw new HttpError(404, `${name ?? '(unnamed)'} is not on the watch list`);
        return repo;
    };

    const requireJobId = (raw: string | undefined) => {
        const jobId = Number.parseInt(raw ?? '', 10);
        if (!Number.isInteger(jobId) || jobId <= 0) throw new HttpError(400, 'Invalid job id');
        return jobId;
    };

    const afterAction = async (name: string) => {
        runtime.activePoller.invalidate(name);
        return { repo: await runtime.activePoller.refreshRepo(name) };
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

    /**
     * `repos.name` is the primary key across every instance, but the board only
     * shows one instance at a time. A clash with a row belonging to another host
     * is therefore invisible, and has to say so rather than claim the repo is
     * "already on the watch list" of a board that plainly does not have it.
     */
    const conflictFor = (name: string, baseUrl: string): string | null => {
        const existing = watchStore.getRepo(name);
        if (!existing) return null;
        return existing.baseUrl === baseUrl
            ? `${name} is already on the watch list`
            : `${name} is already watched on ${existing.baseUrl}, and repo names are shared between instances — remove it there first`;
    };

    /** Applies the store's ordering, which sinks paused repos to the bottom. */
    const applyStoreOrder = () => {
        const baseUrl = runtime.baseUrl;
        if (baseUrl) store.reorder(watchStore.listReposFor(baseUrl).map((record) => record.name));
    };

    /** Ids only transfer within the instance they were resolved against. */
    const addFromEntry = async (entry: ExportedRepo, baseUrl: string) => {
        const reusableId = entry.projectId && (!entry.baseUrl || entry.baseUrl === baseUrl);

        const resolved = reusableId
            ? {
                name: entry.name,
                projectId: entry.projectId!,
                path: entry.path ?? null,
                ref: entry.ref,
                group: entry.group,
            }
            : await resolveNewRepo(runtime.client, entry.path || entry.name, {
                ref: entry.ref,
                group: entry.group,
            });

        const record = watchStore.addRepo({ ...resolved, baseUrl });
        const tags = entry.tags?.length ? watchStore.setRepoTags(baseUrl, record.name, entry.tags) : [];
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
                        activeTags?: string[];
                        scopeSweepToTags?: boolean;
                    }>(request);

                    const patch: Partial<Settings> = {};

                    if (body.pollPeriodSeconds !== undefined) {
                        if (typeof body.pollPeriodSeconds !== 'number') {
                            throw new HttpError(400, 'pollPeriodSeconds must be a number');
                        }
                        patch.pollPeriodSeconds = watchStore.setPollPeriod(body.pollPeriodSeconds);
                    }

                    // The board's tag filter lives on the server because the sweep
                    // reads it too — a view preference that changes what is polled.
                    if (body.activeTags !== undefined) {
                        if (!Array.isArray(body.activeTags)) {
                            throw new HttpError(400, 'activeTags must be an array of names');
                        }
                        patch.activeTags = watchStore.setActiveTags(body.activeTags);
                    }

                    if (body.scopeSweepToTags !== undefined) {
                        if (typeof body.scopeSweepToTags !== 'boolean') {
                            throw new HttpError(400, 'scopeSweepToTags must be a boolean');
                        }
                        patch.scopeSweepToTags = watchStore.setScopeSweepToTags(body.scopeSweepToTags);
                    }

                    if (Object.keys(patch).length === 0) {
                        throw new HttpError(400, 'Nothing to change');
                    }

                    const settings = store.setSettings(patch);
                    if (runtime.configured) runtime.activePoller.trigger();
                    return json({ settings });
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

                    // A renamed tag may be one the board is currently filtered by.
                    const active = watchStore.settings.activeTags;
                    if (active.includes(from)) {
                        store.setSettings({
                            activeTags: watchStore.setActiveTags(active.map((tag) => (tag === from ? to : tag))),
                        });
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

                    const active = watchStore.settings.activeTags;
                    if (active.includes(name)) {
                        store.setSettings({
                            activeTags: watchStore.setActiveTags(active.filter((tag) => tag !== name)),
                        });
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
                    const body = await readJson<{ repos?: string[] }>(request);
                    if (!Array.isArray(body.repos)) {
                        throw new HttpError(400, 'repos must be an array of names');
                    }
                    if (!watchStore.hasTag(baseUrl, name)) {
                        throw new HttpError(404, `${name} is not a tag`);
                    }

                    const applied = watchStore.setTagRepos(baseUrl, name, body.repos);
                    runtime.syncTags(baseUrl);
                    return json({ tag: name, repos: applied, tags: store.getTags() });
                }),
            },

            '/api/repos/:name/tags': {
                PUT: route(deps, async (request) => {
                    const baseUrl = requireBaseUrl();
                    const repo = requireRepo(params(request).name);
                    const body = await readJson<{ tags?: string[] }>(request);
                    if (!Array.isArray(body.tags)) {
                        throw new HttpError(400, 'tags must be an array of names');
                    }

                    const applied = watchStore.setRepoTags(baseUrl, repo.name, body.tags);
                    store.patchRepo(repo.name, { tags: applied });
                    runtime.refreshTags();
                    return json({ tags: applied, allTags: store.getTags() });
                }),
            },

            '/api/sweep': {
                POST: route(deps, () => {
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
                    const conflict = conflictFor(resolved.name, baseUrl);
                    if (conflict) throw new HttpError(409, conflict);

                    const record = watchStore.addRepo({ ...resolved, baseUrl });
                    store.addRepo(repoViewFromRecord(record, baseUrl));
                    const repo = await runtime.activePoller.refreshRepo(record.name);
                    return json({ repo }, 201);
                }),
            },

            '/api/repos/:name': {
                DELETE: route(deps, (request) => {
                    const name = params(request).name!;
                    // Scoped to the active instance, so a name shared with another
                    // host cannot delete a row this board never showed.
                    const record = watchStore.getRepo(name);
                    const baseUrl = runtime.baseUrl;
                    if (!record || (baseUrl !== null && record.baseUrl !== baseUrl)) {
                        throw new HttpError(404, `${name} is not on the watch list`);
                    }

                    watchStore.removeRepo(name);
                    if (runtime.configured) runtime.activePoller.invalidate(name);
                    store.removeRepo(name);
                    return json({ removed: name });
                }),
            },

            '/api/repos/:name/refresh': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
                    return json(await afterAction(repo.name));
                }),
            },

            '/api/repos/:name/watch': {
                PUT: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
                    const body = await readJson<{ watched?: boolean }>(request);
                    if (typeof body.watched !== 'boolean') {
                        throw new HttpError(400, 'watched must be a boolean');
                    }

                    watchStore.setWatched(repo.name, body.watched);
                    store.patchRepo(repo.name, { watched: body.watched });
                    applyStoreOrder();

                    // Resuming should show fresh data at once; pausing changes nothing else.
                    if (body.watched && runtime.configured) {
                        return json({ watched: true, repo: await runtime.activePoller.refreshRepo(repo.name) });
                    }
                    return json({ watched: body.watched });
                }),
            },

            '/api/repos/:name/jobs/:jobId/log': {
                GET: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
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

            '/api/repos/:name/jobs/:jobId/retry': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
                    await runtime.client.retryJob(repo.projectId, requireJobId(params(request).jobId));
                    return json(await afterAction(repo.name));
                }),
            },

            '/api/repos/:name/jobs/:jobId/cancel': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
                    await runtime.client.cancelJob(repo.projectId, requireJobId(params(request).jobId));
                    return json(await afterAction(repo.name));
                }),
            },

            '/api/repos/:name/jobs/:jobId/play': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
                    await runtime.client.playJob(repo.projectId, requireJobId(params(request).jobId));
                    return json(await afterAction(repo.name));
                }),
            },

            '/api/repos/:name/pipeline/retry': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
                    if (!repo.pipeline) throw new HttpError(409, `${repo.name} has no pipeline to retry`);
                    await runtime.client.retryPipeline(repo.projectId, repo.pipeline.id);
                    return json(await afterAction(repo.name));
                }),
            },

            '/api/repos/:name/pipeline/cancel': {
                POST: route(deps, async (request) => {
                    const repo = requireRepo(params(request).name);
                    if (!repo.pipeline) throw new HttpError(409, `${repo.name} has no pipeline to cancel`);
                    await runtime.client.cancelPipeline(repo.projectId, repo.pipeline.id);
                    return json(await afterAction(repo.name));
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

                    // Tags first, so an empty one in the file survives even when
                    // every repo carrying it was already on the board.
                    for (const tag of parseExportTags(payload)) watchStore.createTag(baseUrl, tag);

                    const added: string[] = [];
                    const tagged: string[] = [];
                    const skipped: { repo: string; reason: string }[] = [];

                    for (const entry of entries) {
                        const conflict = conflictFor(entry.name, baseUrl);
                        if (conflict) {
                            // A repo already watched is left alone, but its tags are
                            // merged: that is what makes a file useful for sharing a
                            // tag layout with someone whose board already has the repos.
                            const merged = entry.tags?.length
                                && watchStore.getRepo(entry.name)?.baseUrl === baseUrl;
                            if (merged) {
                                const applied = watchStore.addRepoTags(baseUrl, entry.name, entry.tags!);
                                store.patchRepo(entry.name, { tags: applied });
                                tagged.push(entry.name);
                                continue;
                            }
                            skipped.push({ repo: entry.name, reason: conflict });
                            continue;
                        }
                        try {
                            const record = await addFromEntry(entry, baseUrl);
                            added.push(record.name);
                        } catch (error) {
                            skipped.push({ repo: entry.name, reason: describeError(error) });
                        }
                    }

                    runtime.refreshTags();
                    if (added.length > 0) runtime.activePoller.trigger();
                    return json({ added, tagged, skipped });
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
