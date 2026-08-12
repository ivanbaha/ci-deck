import type { AppMeta, AppState, NotificationEvent, RepoView, ServerEvent, Settings, SweepInfo, TagView } from '../shared/types.ts';
import type { RepoRecord } from '../store/watch-store.ts';

export type Listener = (event: ServerEvent) => void;

/**
 * Where a row links to, which the board turns into `…/-/pipelines` and
 * `…/-/commit/…`. A stored path resolves against the instance — but resolving is
 * not the same as belonging to it: `https://elsewhere/x`, `//elsewhere/x` and
 * `javascript:…` all survive `new URL(path, base)` and would put an attacker's
 * link under a repo's own name. A watch list is a file people share, so the path
 * in one is not trusted to be the relative `group/repo` it is supposed to be.
 *
 * Null rather than a corrected guess: a row with no link renders as plain text,
 * which is the honest outcome for a path this instance cannot account for.
 */
export function projectUrl(path: string | null, gitlabBaseUrl: string): string | null {
    if (!path) return null;

    try {
        const base = new URL(gitlabBaseUrl);
        const resolved = new URL(path, base);
        if (resolved.origin !== base.origin || !resolved.href.startsWith(base.href)) return null;
        return resolved.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

/** A freshly loaded row: known identity, nothing fetched from GitLab yet. */
export function repoViewFromRecord(record: RepoRecord, gitlabBaseUrl: string, tags: string[] = []): RepoView {
    return {
        id: record.id,
        name: record.name,
        group: record.group,
        tags,
        projectId: record.projectId,
        ref: record.ref,
        watched: record.watched,
        notify: record.notify,
        branchMissing: record.branchMissing,
        webUrl: projectUrl(record.path, gitlabBaseUrl),
        health: 'unknown',
        pipeline: null,
        stages: [],
        lastCheckedAt: null,
        lastError: null,
        checking: false,
    };
}

/**
 * Single source of truth for the board. Mutations fan out to SSE subscribers so
 * the UI updates repo by repo as the sweep walks the watch list.
 */
export class AppStore {
    private readonly repos = new Map<number, RepoView>();
    private order: number[] = [];
    private readonly listeners = new Set<Listener>();
    private tags: TagView[] = [];
    private settings: Settings;
    /** Rows the board is currently showing, in the order they appear on it. */
    private focus: number[] = [];
    private sweep: SweepInfo = {
        running: false,
        index: 0,
        total: 0,
        currentRepo: null,
        startedAt: null,
        finishedAt: null,
        lastDurationMs: null,
        nextRunAt: null,
    };
    private meta: AppMeta;

    constructor(settings: Settings, meta: AppMeta) {
        this.settings = settings;
        this.meta = meta;
    }

    snapshot(): AppState {
        return {
            repos: this.order.map((id) => this.repos.get(id)!),
            tags: this.tags.map((tag) => ({ ...tag })),
            settings: { ...this.settings },
            sweep: { ...this.sweep },
            meta: { ...this.meta },
        };
    }

    subscribe(listener: Listener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: ServerEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch {
                this.listeners.delete(listener);
            }
        }
    }

    get repoIds(): number[] {
        return [...this.order];
    }

    getRepo(id: number): RepoView | undefined {
        return this.repos.get(id);
    }

    setRepos(views: RepoView[]): void {
        this.repos.clear();
        this.order = views.map((view) => view.id);
        for (const view of views) this.repos.set(view.id, view);
        this.emit({ type: 'repos', repos: this.snapshot().repos });
    }

    addRepo(view: RepoView): void {
        this.repos.set(view.id, view);
        if (!this.order.includes(view.id)) this.order.push(view.id);
        this.emit({ type: 'repo', repo: view });
    }

    /**
     * Changes row order only. Views keep whatever GitLab data they already hold,
     * so re-sorting after a pause never blanks the board.
     */
    reorder(ids: number[]): void {
        const known = ids.filter((id) => this.repos.has(id));
        const missing = this.order.filter((id) => !known.includes(id));
        this.order = [...known, ...missing];
        this.emit({ type: 'repos', repos: this.snapshot().repos });
    }

    removeRepo(id: number): boolean {
        if (!this.repos.delete(id)) return false;
        this.order = this.order.filter((entry) => entry !== id);
        this.focus = this.focus.filter((entry) => entry !== id);
        this.emit({ type: 'repos', repos: this.snapshot().repos });
        return true;
    }

    patchRepo(id: number, patch: Partial<RepoView>): RepoView | undefined {
        const current = this.repos.get(id);
        if (!current) return undefined;
        const next = { ...current, ...patch };
        this.repos.set(id, next);
        this.emit({ type: 'repo', repo: next });
        return next;
    }

    getTags(): TagView[] {
        return this.tags.map((tag) => ({ ...tag }));
    }

    /**
     * Swaps the tags on every row and nothing else.
     *
     * The obvious alternative — reloading the rows from the store — throws away
     * the pipeline, stages and health that only GitLab can supply, so renaming a
     * tag would blank the whole board until the next sweep refilled it.
     */
    setRepoTags(byRepo: Map<number, string[]>): void {
        for (const [id, view] of this.repos) {
            this.repos.set(id, { ...view, tags: byRepo.get(id) ?? [] });
        }
        this.emit({ type: 'repos', repos: this.snapshot().repos });
    }

    setTags(tags: TagView[]): void {
        this.tags = tags.map((tag) => ({ ...tag }));
        this.emit({ type: 'tags', tags: this.getTags() });
    }

    /**
     * What the board is showing, so the sweep can visit those rows first.
     *
     * Deliberately an ordering and not a filter. Skipping the rest would make a
     * search box quietly decide which repos still notify you, and the whole point
     * of watching a repo is that you find out without looking at it.
     */
    setFocus(ids: number[]): void {
        this.focus = ids.filter((id) => this.repos.has(id));
    }

    /** Every repo, with the ones on screen at the front. */
    sweepOrder(): number[] {
        if (this.focus.length === 0) return [...this.order];
        const first = new Set(this.focus);
        return [...this.focus, ...this.order.filter((id) => !first.has(id))];
    }

    getSettings(): Settings {
        return { ...this.settings };
    }

    setMeta(meta: AppMeta): void {
        this.meta = meta;
        this.emit({ type: 'meta', meta: { ...meta } });
    }

    setSettings(patch: Partial<Settings>): Settings {
        this.settings = { ...this.settings, ...patch };
        this.emit({ type: 'settings', settings: this.getSettings() });
        return this.getSettings();
    }

    setSweep(patch: Partial<SweepInfo>): void {
        this.sweep = { ...this.sweep, ...patch };
        this.emit({ type: 'sweep', sweep: { ...this.sweep } });
    }

    notify(notification: NotificationEvent): void {
        this.emit({ type: 'notify', notification });
    }

    /** GitLab rejected the token, which is also the end of polling until it changes. */
    setAuthError(message: string): void {
        this.meta = { ...this.meta, authError: message, polling: false };
        this.emit({ type: 'auth-error', message });
    }
}
