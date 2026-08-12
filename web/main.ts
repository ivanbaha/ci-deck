import type {
    AppState,
    ColumnKey,
    JobView,
    NotifyMode,
    RepoView,
    ServerEvent,
    StageView,
    TagView,
} from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { columnResizer } from './columns.ts';
import { INTERVALS, openConfig, refreshConfig } from './config.ts';
import { connectionButton } from './connection.ts';
import { byId, clear, h } from './dom.ts';
import { icon, logo } from './icons.ts';
import { openImportDialog } from './import.ts';
import { openJobLog } from './job-log.ts';
import { openMenu } from './menu.ts';
import { addRepoDialog, confirmDialog } from './modal.ts';
import { announce } from './notify.ts';
import { renderGroupHeader, renderRepo, repoTab, type TabKey } from './render.ts';
import { closeSetup, openSetup } from './setup.ts';
import * as popover from './stage-popover.ts';
import { setTagStyles } from './tag-style.ts';
import { renderTagBar, repoLabel } from './tags.ts';
import { applyTheme, restoreTheme } from './theme.ts';
import { toastError, toastInfo } from './toast.ts';
import { initTooltips } from './tooltip.ts';
import { DEFAULT_VIEW, onViewChange, readView, writeView, type ViewState } from './view-state.ts';

const TABS: { key: TabKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'failed', label: 'Failed' },
    { key: 'running', label: 'Running' },
    { key: 'passed', label: 'Passed' },
    { key: 'other', label: 'Other' },
];

const TIME_REFRESH_MS = 15_000;

/** Long enough that dragging a search term does not post six times. */
const FOCUS_DEBOUNCE_MS = 500;

const board = byId<HTMLTableElement>('board');
const placeholder = byId<HTMLTableSectionElement>('placeholder');
const tabsBar = byId('tabs');
const groupSelect = byId<HTMLSelectElement>('group');
const searchInput = byId<HTMLInputElement>('search');
const intervalSelect = byId<HTMLSelectElement>('interval');
const progressBar = byId('progress-bar');
const sweepLabel = byId('sweep');
const banner = byId('banner');
const tagbar = byId('tagbar');
const firstRun = byId<HTMLTableSectionElement>('first-run');
const topbar = document.querySelector<HTMLElement>('.topbar')!;
const columnHeader = board.querySelector<HTMLElement>('thead tr')!;

// Before anything is fetched, so the first paint is not the wrong colour.
restoreTheme();

let state: AppState | null = null;
const rows = new Map<number, HTMLTableRowElement>();
const groupHeaders = new Map<string, HTMLTableRowElement>();
let view: ViewState = readView();

function repos(): RepoView[] {
    return state?.repos ?? [];
}

function tags(): TagView[] {
    return state?.tags ?? [];
}

function globalNotify(): NotifyMode {
    return state?.settings.notifications ?? 'on';
}

/**
 * Display order: namespace first so each group is one contiguous section, then
 * the store's own order within it — which puts paused rows last and keeps the
 * branches of one repo side by side.
 */
function groupedRepos(): [string, RepoView[]][] {
    const byGroup = new Map<string, RepoView[]>();
    for (const repo of repos()) {
        const list = byGroup.get(repo.group);
        if (list) list.push(repo);
        else byGroup.set(repo.group, [repo]);
    }
    return [...byGroup.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function findRepo(id: number | undefined): RepoView | undefined {
    return id === undefined ? undefined : repos().find((repo) => repo.id === id);
}

function repoIdOf(target: HTMLElement): number | undefined {
    const raw = Number.parseInt(target.dataset.repo ?? '', 10);
    return Number.isInteger(raw) ? raw : undefined;
}

/** Keeps an unusual stored value selectable instead of silently changing it. */
function renderIntervals(seconds: number): void {
    const options = INTERVALS.some((entry) => entry.seconds === seconds)
        ? INTERVALS
        : [...INTERVALS, { seconds, label: `${seconds}s` }].sort((a, b) => a.seconds - b.seconds);

    clear(intervalSelect);
    for (const { seconds: value, label } of options) {
        intervalSelect.appendChild(h('option', { value: String(value), text: label }));
    }
    intervalSelect.value = String(seconds);
}

/** Comma-separated terms are an OR, so an ad-hoc set can be typed in one go. */
function searchTerms(): string[] {
    return view.search.toLowerCase().split(',').map((term) => term.trim()).filter(Boolean);
}

function matchesSearch(repo: RepoView): boolean {
    const terms = searchTerms();
    if (terms.length === 0) return true;
    const haystack = `${repo.name} ${repo.ref}`.toLowerCase();
    return terms.some((term) => haystack.includes(term));
}

function matchesFilters(repo: RepoView): boolean {
    if (view.tab !== 'all' && repoTab(repo) !== view.tab) return false;
    if (view.group !== 'all' && repo.group !== view.group) return false;

    // Tags union rather than intersect: picking `backs` and `front` asks for
    // both sets, which is what "show me these groups" means.
    if (view.tags.length > 0 && !repo.tags.some((tag) => view.tags.includes(tag))) return false;

    return matchesSearch(repo);
}

const stageHandlers: popover.StageHandlers = {
    openLog(stage, job) {
        const repo = findRepo(popover.openStage()?.repo);
        if (repo) openJobLog({ repo, stage, job, onRepo: applyRepo });
    },
    act(_stage, job, action) {
        const id = popover.openStage()?.repo;
        if (id !== undefined) void runJobAction(id, job, action);
    },
    actOnStage(stage, action) {
        const id = popover.openStage()?.repo;
        if (id !== undefined) void runStageAction(id, stage, action);
    },
};

const JOB_ACTION_VERB: Record<popover.JobAction, string> = {
    retry: 'Retrying',
    cancel: 'Cancelling',
    play: 'Starting',
};

/** Manual jobs commonly deploy somewhere real, so starting one can ask first. */
async function confirmPlay(what: string, where: string): Promise<boolean> {
    if (state?.settings.confirmManualRun === false) return true;
    return confirmDialog({
        title: 'Start manual job',
        message: `Start ${what} in ${where}? Manual jobs often deploy to a real environment.`,
        confirmLabel: 'Start',
    });
}

/** Acts on a single job, then lets the refreshed row rebuild the popover. */
async function runJobAction(id: number, job: JobView, action: popover.JobAction): Promise<void> {
    const repo = findRepo(id);
    if (!repo) return;

    if (action === 'play' && !(await confirmPlay(`the manual job "${job.name}"`, repoLabel(repo)))) return;

    try {
        const result = action === 'retry'
            ? await api.retryJob(id, job.id)
            : action === 'cancel'
                ? await api.cancelJob(id, job.id)
                : await api.playJob(id, job.id);

        toastInfo(`${JOB_ACTION_VERB[action]} ${job.name}`);
        if (result.repo) applyRepo(result.repo);
    } catch (error) {
        toastError(error);
    }
}

/**
 * Acts on every job in a stage that the action applies to. One request rather
 * than one per job: the server fans out and the row comes back once.
 */
async function runStageAction(id: number, stage: StageView, action: popover.JobAction): Promise<void> {
    const repo = findRepo(id);
    if (!repo) return;

    const count = stage.jobs.filter((job) =>
        action === 'retry'
            ? job.status === 'failed'
            : action === 'play'
                ? job.status === 'manual'
                : true).length;

    if (action === 'play' && !(await confirmPlay(`${count} manual job${count === 1 ? '' : 's'} in "${stage.name}"`, repoLabel(repo)))) {
        return;
    }
    if (action === 'cancel') {
        const confirmed = await confirmDialog({
            title: 'Cancel stage',
            message: `Cancel every job still running in "${stage.name}" of ${repoLabel(repo)}?`,
            confirmLabel: 'Cancel jobs',
            danger: true,
        });
        if (!confirmed) return;
    }

    try {
        const result = await api.actOnStage(id, stage.name, action);
        const verb = JOB_ACTION_VERB[action];
        toastInfo(
            `${verb} ${result.acted} job${result.acted === 1 ? '' : 's'} in ${stage.name}`
            + (result.failed > 0 ? ` — ${result.failed} would not` : ''),
        );
        if (result.repo) applyRepo(result.repo);
    } catch (error) {
        toastError(error);
    }
}

const anchorFinder = (id: number) => (stage: string) =>
    rows.get(id)?.querySelector<HTMLElement>(
        `[data-action="stage"][data-stage="${CSS.escape(stage)}"]`,
    ) ?? null;

/** Re-renders replace the anchor node, so an open popover has to be re-hung. */
function reattachPopover(): void {
    const open = popover.openStage();
    if (!open) return;

    const repo = findRepo(open.repo);
    if (!repo) {
        popover.close();
        return;
    }
    popover.reattach(repo, anchorFinder(open.repo), stageHandlers);
}

function renderTabs(): void {
    const counts = new Map<TabKey, number>([['all', repos().length]]);
    for (const repo of repos()) {
        const key = repoTab(repo);
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    clear(tabsBar);
    for (const { key, label } of TABS) {
        tabsBar.appendChild(
            h(
                'button',
                {
                    type: 'button',
                    class: 'tab',
                    role: 'tab',
                    'aria-selected': String(view.tab === key),
                    onClick: () => updateView({ tab: key }),
                },
                label,
                h('span', { class: 'count', text: String(counts.get(key) ?? 0) }),
            ),
        );
    }
}

/** Rows the current filter shows, ignoring the tag part of it. */
function filterMatches(): RepoView[] {
    return repos().filter((repo) => {
        if (view.tab !== 'all' && repoTab(repo) !== view.tab) return false;
        if (view.group !== 'all' && repo.group !== view.group) return false;
        return matchesSearch(repo);
    });
}

/**
 * The filter is saved as an explicit membership list, not as a rule. Nothing is
 * inferred from the name — the search just spares you ticking sixty boxes once.
 *
 * Hands the whole thing to the tag manager rather than making the tag here: it
 * is the same tag as any other, and it should be named, described and coloured
 * in the same form, with the rows it will carry already ticked behind it.
 */
function saveFilterAsTag(): void {
    openConfig(configOptions, 'tags', {
        // What was typed is the obvious name for what it matched. The group is
        // the next best thing when the narrowing came from there.
        name: view.search.trim() || (view.group === 'all' ? '' : view.group),
        repos: filterMatches().map((repo) => repo.id),
    });
}

function renderTagbar(): void {
    const matches = filterMatches();

    // Before any row is drawn: the chips on a row take their colour from here.
    setTagStyles(tags());

    renderTagBar({
        container: tagbar,
        tags: tags(),
        active: view.tags,
        // Saving the current filter only means something when it is narrower than
        // the whole board and no tag is doing the narrowing already.
        saveable: view.tags.length === 0 && matches.length > 0 && matches.length < repos().length,
        onToggle: (tag) =>
            updateView({
                tags: view.tags.includes(tag)
                    ? view.tags.filter((entry) => entry !== tag)
                    : [...view.tags, tag],
            }),
        onClear: () => updateView({ tags: [] }),
        onSaveFilter: saveFilterAsTag,
    });
}

/**
 * The one place the view changes. Everything that narrows the board goes through
 * here, so the URL, the controls and the rows can never disagree about what is
 * being shown.
 */
function updateView(patch: Partial<ViewState>): void {
    view = { ...view, ...patch };
    writeView(view);
    syncControls();
    renderTabs();
    applyFilters();
    renderTagbar();
}

/** Pushes the controls back to whatever the view says, after a URL change. */
function syncControls(): void {
    if (searchInput.value !== view.search) searchInput.value = view.search;
    const groups = [...groupSelect.options].map((option) => option.value);
    groupSelect.value = groups.includes(view.group) ? view.group : DEFAULT_VIEW.group;
}

/** Pulls the whole board again after a change that can move many rows at once. */
async function reload(): Promise<void> {
    try {
        applyState(await api.state());
    } catch (error) {
        toastError(error);
    }
}

function renderGroups(): void {
    const groups = [...new Set(repos().map((repo) => repo.group))].sort();

    clear(groupSelect);
    groupSelect.appendChild(h('option', { value: 'all', text: 'All groups' }));
    for (const group of groups) {
        groupSelect.appendChild(h('option', { value: group, text: group }));
    }

    // A filter naming a group that has since gone would hide everything, silently.
    if (view.group !== 'all' && !groups.includes(view.group)) view = { ...view, group: 'all' };
    groupSelect.value = view.group;
}

/**
 * Pins the heading of whichever section the top of the board is currently inside,
 * and only that one. CSS cannot do it: a sticky table cell is bound by the table,
 * not by its row group, so every heading that scrolled past would stay pinned at
 * the same offset and the name on screen would be the wrong one.
 */
function updateStickyGroups(): void {
    const offset = topbar.offsetHeight + columnHeader.offsetHeight;
    board.style.setProperty('--sticky-offset', `${offset}px`);

    for (const header of groupHeaders.values()) {
        const section = header.parentElement;
        if (!section || header.hidden) {
            header.classList.remove('group-pinned');
            continue;
        }
        const box = section.getBoundingClientRect();
        header.classList.toggle('group-pinned', box.top <= offset && box.bottom > offset);
    }
}

let stickyFrame = 0;

function scheduleStickyGroups(): void {
    if (stickyFrame) return;
    stickyFrame = requestAnimationFrame(() => {
        stickyFrame = 0;
        updateStickyGroups();
    });
}

let focusTimer: ReturnType<typeof setTimeout> | null = null;
let lastFocus = '';

/**
 * Tells the server which rows are on screen, so the sweep reaches them first.
 *
 * An ordering and not a filter, deliberately: everything watched is still swept,
 * because a repo you have filtered out is still a repo you asked to be told
 * about. Narrowing the board shortens the wait for what you are looking at, and
 * changes nothing about what notifies you.
 */
function reportFocus(): void {
    if (focusTimer) clearTimeout(focusTimer);
    focusTimer = setTimeout(() => {
        const visible = repos().filter((repo) => matchesFilters(repo)).map((repo) => repo.id);
        const key = visible.join(',');
        if (key === lastFocus) return;
        lastFocus = key;
        api.setFocus(visible).catch(() => undefined);
    }, FOCUS_DEBOUNCE_MS);
}

function applyFilters(): void {
    let visible = 0;
    const shownPerGroup = new Map<string, number>();

    for (const [id, row] of rows) {
        const repo = findRepo(id);
        const show = repo ? matchesFilters(repo) : false;
        row.hidden = !show;
        if (!show || !repo) continue;

        visible += 1;
        shownPerGroup.set(repo.group, (shownPerGroup.get(repo.group) ?? 0) + 1);
    }

    // A section with nothing left in it should go too, not sit there empty.
    for (const [group, header] of groupHeaders) {
        header.hidden = (shownPerGroup.get(group) ?? 0) === 0;
    }

    const empty = repos().length === 0;
    firstRun.hidden = !empty;
    placeholder.hidden = empty || visible > 0;

    if (!placeholder.hidden) {
        clear(placeholder);
        placeholder.appendChild(
            h('tr', {}, h('td', { colSpan: 7, class: 'empty', text: 'No repos match the filters.' })),
        );
    }

    scheduleStickyGroups();
    reportFocus();
}

function renderAll(): void {
    rows.clear();
    groupHeaders.clear();
    for (const section of [...board.querySelectorAll('tbody.group-body')]) section.remove();

    const openStage = popover.openStage();
    const now = Date.now();
    const notify = globalNotify();

    // One tbody per group, holding its heading and its rows. That is what keeps
    // the sticky heading bounded to its own section.
    for (const [group, members] of groupedRepos()) {
        const section = h('tbody', { class: 'group-body', 'data-group': group });

        const header = renderGroupHeader(group, members);
        groupHeaders.set(group, header);
        section.appendChild(header);

        for (const repo of members) {
            const row = renderRepo(repo, openStage, now, notify);
            rows.set(repo.id, row);
            section.appendChild(row);
        }

        board.appendChild(section);
    }

    renderTabs();
    applyFilters();
    reattachPopover();
}

function replaceRow(repo: RepoView): void {
    const existing = rows.get(repo.id);

    // A row that is not on the board yet has no section to go under, and one
    // whose group changed is in the wrong one — either way, rebuild.
    if (!existing || !groupHeaders.has(repo.group)) {
        renderGroups();
        renderAll();
        return;
    }

    const row = renderRepo(repo, popover.openStage(), Date.now(), globalNotify());
    rows.set(repo.id, row);
    existing.replaceWith(row);

    // The section counts a repo that just went red, so refresh its heading too.
    const header = groupHeaders.get(repo.group)!;
    const refreshed = renderGroupHeader(repo.group, repos().filter((entry) => entry.group === repo.group));
    header.replaceWith(refreshed);
    groupHeaders.set(repo.group, refreshed);

    row.hidden = !matchesFilters(repo);
    renderTabs();
    applyFilters();
    reattachPopover();
}

function applyRepo(repo: RepoView): void {
    if (!state) return;
    const index = state.repos.findIndex((entry) => entry.id === repo.id);
    if (index === -1) state.repos.push(repo);
    else state.repos[index] = repo;
    replaceRow(repo);
}

function renderMeta(): void {
    if (!state) return;
    const { meta } = state;

    connection.update(meta);

    const problem = meta.authError
        ? `Polling stopped — ${meta.authError}`
        : meta.credentials.reachError
            ? `${meta.gitlabBaseUrl} is unreachable — ${meta.credentials.reachError}`
            : null;

    banner.hidden = problem === null;
    if (problem) banner.textContent = problem;

    // A board with no usable credentials cannot do anything until they are given.
    const needsSetup = !meta.credentials.complete || Boolean(meta.credentials.authError);
    if (needsSetup) openSetup(meta.credentials, { dismissible: false });
    else closeSetup();
}

function renderSweep(): void {
    if (!state) return;
    const { sweep } = state;

    if (sweep.running) {
        const percent = sweep.total === 0 ? 0 : Math.round((sweep.index / sweep.total) * 100);
        progressBar.style.width = `${percent}%`;
        // The count only. Naming the repo being checked made this box as wide as
        // the longest repo on the board and back again, twice a second, which
        // moved the interval control and the button beside it with it.
        sweepLabel.textContent = `checking ${sweep.index}/${sweep.total}`;
        return;
    }

    progressBar.style.width = '0%';
    const seconds = sweep.nextRunAt
        ? Math.max(0, Math.round((Date.parse(sweep.nextRunAt) - Date.now()) / 1_000))
        : null;
    const next = seconds === null
        ? ''
        : seconds >= 60
            ? `next in ${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
            : `next in ${seconds}s`;
    const took = sweep.lastDurationMs ? `${Math.round(sweep.lastDurationMs / 1_000)}s` : null;

    sweepLabel.textContent = [took ? `swept in ${took}` : 'idle', next].filter(Boolean).join(' · ');
}

function applySettings(): void {
    if (!state) return;
    renderIntervals(state.settings.pollPeriodSeconds);
    applyTheme(state.settings.theme);
    columns.apply(state.settings.columnWidths);
}

/** One place to swallow a whole new board, used by the SSE snapshot and reloads. */
function applyState(next: AppState): void {
    state = next;
    applySettings();
    renderGroups();
    syncControls();
    renderTagbar();
    renderAll();
    renderMeta();
    renderSweep();
}

function handleEvent(event: ServerEvent): void {
    switch (event.type) {
        case 'snapshot':
            applyState(event.state);
            break;
        case 'repos':
            if (!state) return;
            state.repos = event.repos;
            renderGroups();
            renderTagbar();
            renderAll();
            renderMeta();
            break;
        case 'tags':
            if (!state) return;
            state.tags = event.tags;
            renderTagbar();
            // A recoloured or renamed tag is on every row that carries it.
            renderAll();
            break;
        case 'repo':
            applyRepo(event.repo);
            break;
        case 'sweep':
            if (!state) return;
            state.sweep = event.sweep;
            renderSweep();
            break;
        case 'settings': {
            if (!state) return;
            // The bells on every row read the global setting, and nothing else in
            // here reaches a row — so a dragged column moves a CSS variable and
            // leaves the forty rows under it alone, popover included.
            const bells = state.settings.notifications !== event.settings.notifications;

            state.settings = event.settings;
            applyTheme(event.settings.theme);
            columns.apply(event.settings.columnWidths);
            if (document.activeElement !== intervalSelect) {
                renderIntervals(event.settings.pollPeriodSeconds);
            }
            if (bells) renderAll();
            refreshConfig();
            break;
        }
        case 'notify':
            announce(event.notification);
            break;
        case 'meta':
            if (!state) return;
            state.meta = event.meta;
            renderGroups();
            renderAll();
            renderMeta();
            break;
        case 'auth-error':
            if (!state) return;
            state.meta = { ...state.meta, authError: event.message };
            renderMeta();
            break;
    }
}

/** on → snooze → off → on. One control for three states, like the eye for two. */
const NEXT_NOTIFY: Record<NotifyMode, NotifyMode> = { on: 'snooze', snooze: 'off', off: 'on' };

const NOTIFY_SAID: Record<NotifyMode, string> = {
    on: 'will notify with a sound',
    snooze: 'will notify silently',
    off: 'will stay quiet',
};

async function onAction(action: string, target: HTMLElement): Promise<void> {
    const id = repoIdOf(target);
    const repo = findRepo(id);
    if (id === undefined || !repo) return;

    if (action === 'stage') {
        const stage = repo.stages.find((entry) => entry.name === target.dataset.stage);
        if (stage) popover.toggle(target, repo, stage, stageHandlers);
        return;
    }

    if (action === 'cycle-notify') {
        const next = NEXT_NOTIFY[repo.notify];
        try {
            await api.setNotify(id, next);
            toastInfo(`${repoLabel(repo)} ${NOTIFY_SAID[next]}`);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'refresh-repo') {
        try {
            const result = await api.refreshRepo(id);
            if (result.repo) applyRepo(result.repo);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'retry-pipeline') {
        popover.close();
        try {
            const result = await api.retryPipeline(id);
            if (result.repo) applyRepo(result.repo);
            toastInfo(`Retrying failed jobs of ${repoLabel(repo)}`);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'cancel-pipeline') {
        popover.close();
        const confirmed = await confirmDialog({
            title: 'Cancel pipeline',
            message: `Cancel the running pipeline of ${repoLabel(repo)}? Jobs already finished stay as they are.`,
            confirmLabel: 'Cancel pipeline',
            danger: true,
        });
        if (!confirmed) return;

        try {
            const result = await api.cancelPipeline(id);
            if (result.repo) applyRepo(result.repo);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'watch-repo' || action === 'unwatch-repo') {
        const watched = action === 'watch-repo';
        popover.close();

        try {
            await api.setWatched(id, watched);
            toastInfo(`${repoLabel(repo)} ${watched ? 'is being watched again' : 'paused — check it manually when needed'}`);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'remove-repo') {
        popover.close();
        const confirmed = await confirmDialog({
            title: 'Remove row',
            message: repo.branchMissing
                ? `Remove ${repoLabel(repo)} from the board? That branch is gone from GitLab, so nothing here will change again.`
                : `Remove ${repoLabel(repo)} from the board entirely? To keep it but stop checking it periodically, pause it instead.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!confirmed) return;

        try {
            await api.removeRepo(id);
            toastInfo(`${repoLabel(repo)} removed from the board`);
        } catch (error) {
            toastError(error);
        }
    }
}

board.addEventListener('click', (event) => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('[data-action]');
    if (!target) return;
    void onAction(target.dataset.action!, target);
});

// Delegated, so rows rebuilt by a sweep keep their tips without re-wiring.
initTooltips();

document.addEventListener('mousedown', (event) => {
    const node = event.target as HTMLElement;
    if (popover.isInside(node) || node.closest('[data-action="stage"]')) return;
    popover.close();
});

document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    // A modal on top owns Escape; the popover only reacts when nothing covers it.
    if (!document.querySelector('.overlay')) popover.close();
});

window.addEventListener('resize', () => {
    popover.position();
    scheduleStickyGroups();
    // The columns divide up the room the table has, so a narrower window is a
    // different division of a smaller total rather than a table that overflows.
    columns.relayout();
});
window.addEventListener('scroll', () => {
    popover.position();
    scheduleStickyGroups();
}, true);

searchInput.addEventListener('input', () => updateView({ search: searchInput.value.trim() }));
groupSelect.addEventListener('change', () => updateView({ group: groupSelect.value }));

// Back and forward move the board, since that is where the filter now lives.
onViewChange((next) => {
    view = next;
    syncControls();
    renderTabs();
    applyFilters();
    renderTagbar();
});

async function saveSettings(patch: Parameters<typeof api.setSettings>[0]): Promise<void> {
    const { settings } = await api.setSettings(patch);
    if (!state) return;

    // Same reasoning as the SSE handler: the bells are the only thing on a row
    // that a setting reaches, so nothing else here is worth redrawing them for.
    const bells = state.settings.notifications !== settings.notifications;
    state.settings = settings;
    applySettings();
    if (bells) renderAll();
}

const configOptions = {
    state: () => state,
    save: saveSettings,
    reload: () => void reload(),
};

// Applied on select: an Apply button for one dropdown is a click nobody needs.
intervalSelect.addEventListener('change', () => {
    const seconds = Number.parseInt(intervalSelect.value, 10);
    const label = intervalSelect.selectedOptions[0]?.textContent ?? `${seconds}s`;

    saveSettings({ pollPeriodSeconds: seconds })
        .then(() => toastInfo(`Checking every ${label}`))
        .catch((error) => {
            if (state) renderIntervals(state.settings.pollPeriodSeconds);
            toastError(error);
        });
});

const columns = columnResizer(board, (widths: Partial<Record<ColumnKey, number>>) => {
    api.setSettings({ columnWidths: widths }).catch(toastError);
});

function openAddRepo(): void {
    addRepoDialog(state?.settings.defaultRef ?? 'main', tags(), async ({ repo, ref, tags: wanted }) => {
        const result = await api.addRepo(repo, ref || undefined);
        if (wanted.length > 0) await api.setRepoTags(result.repo.id, wanted);
        toastInfo(`${result.repo.name} · ${result.repo.ref} is now being watched`);
        if (wanted.length > 0) await reload();
    });
}

function openImport(): void {
    openImportDialog(
        repos(),
        state?.settings.defaultRef ?? 'main',
        () => void api.sweep().catch(() => undefined),
    );
}

/** Export is a plain navigation, so the browser saves it without any fetch of ours. */
function exportList(): void {
    const link = h('a', { href: '/api/export', download: 'ci-deck-watchlist.json' });
    document.body.appendChild(link);
    link.click();
    link.remove();
}

byId('brand').prepend(logo(28));

const connection = connectionButton(() => state?.meta ?? null);

/**
 * Adding is the common case, so it keeps the primary half of the button. Import
 * and export sit behind the caret: both move the whole list, both are rare, and
 * neither belongs inside a dialog called "Add repo".
 */
const addRepo = button({
    label: 'Add a repo to watch',
    icon: 'plus',
    text: 'Add repo',
    variant: 'confirm',
    onClick: openAddRepo,
});

const listMenu = h('button', {
    type: 'button',
    class: 'btn btn-confirm btn-split',
    'data-tip': 'Import or export the watch list',
    'aria-label': 'Import or export the watch list',
    'aria-haspopup': 'menu',
    'aria-expanded': 'false',
}, icon('chevron', 16));

listMenu.addEventListener('click', () =>
    openMenu(listMenu, [
        { label: 'Import a list…', icon: 'import', onSelect: openImport },
        { label: 'Export the list', icon: 'export', onSelect: exportList },
    ]),
);

byId('topbar-actions').append(
    connection.element,
    h('span', { class: 'split' }, addRepo, listMenu),
    button({
        label: 'Configuration',
        icon: 'cog',
        variant: 'inverted',
        onClick: () => openConfig(configOptions),
    }),
);

byId('sweep-actions').append(
    button({
        label: 'Check every repo now',
        icon: 'refresh',
        variant: 'inverted',
        onClick: () => api.sweep().then(() => toastInfo('Sweep started')).catch(toastError),
    }),
);

byId('first-run-actions').append(
    button({ label: 'Add a repo to watch', icon: 'plus', text: 'Add your first repo', variant: 'confirm', onClick: openAddRepo }),
    button({ label: 'Import a watch list', icon: 'import', text: 'Import a watch list', onClick: openImport }),
);

setInterval(renderSweep, 1_000);

setInterval(() => {
    const busy = board.contains(document.activeElement)
        || document.querySelector('.overlay')
        || popover.openStage();
    if (!busy) renderAll();
}, TIME_REFRESH_MS);

const events = new EventSource('/api/events');
events.addEventListener('message', (event) => {
    if (!event.data) return;
    try {
        handleEvent(JSON.parse(event.data) as ServerEvent);
    } catch (error) {
        toastError(error);
    }
});
events.addEventListener('error', () => {
    sweepLabel.textContent = 'reconnecting…';
});

api.state().then((next) => handleEvent({ type: 'snapshot', state: next })).catch(toastError);
