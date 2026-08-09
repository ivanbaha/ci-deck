import type { AppState, JobView, RepoView, ServerEvent, Settings, TagView } from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { connectionButton } from './connection.ts';
import { byId, clear, h } from './dom.ts';
import { icon, logo } from './icons.ts';
import { openImportDialog } from './import.ts';
import { openJobLog } from './job-log.ts';
import { openMenu } from './menu.ts';
import { addRepoDialog, confirmDialog } from './modal.ts';
import { renderGroupHeader, renderRepo, repoTab, type TabKey } from './render.ts';
import { closeSetup, openSetup } from './setup.ts';
import * as popover from './stage-popover.ts';
import { openManageTags, openRepoTags, renderTagBar } from './tags.ts';
import { toastError, toastInfo } from './toast.ts';

const TABS: { key: TabKey; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'failed', label: 'Failed' },
    { key: 'running', label: 'Running' },
    { key: 'passed', label: 'Passed' },
    { key: 'other', label: 'Other' },
];

const TIME_REFRESH_MS = 15_000;

/** Fixed choices beat a free-form number: every option is a sensible poll rate. */
const INTERVALS: { seconds: number; label: string }[] = [
    { seconds: 30, label: '30s' },
    { seconds: 60, label: '60s' },
    { seconds: 120, label: '2m' },
    { seconds: 300, label: '5m' },
    { seconds: 600, label: '10m' },
    { seconds: 900, label: '15m' },
];

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

let state: AppState | null = null;
const rows = new Map<string, HTMLTableRowElement>();
const groupHeaders = new Map<string, HTMLTableRowElement>();
let activeTab: TabKey = 'all';
let groupFilter = 'all';
let searchTerm = '';

function repos(): RepoView[] {
    return state?.repos ?? [];
}

/**
 * Display order: namespace first so each group is one contiguous section, then
 * the store's own order within it — which already puts paused repos last, so
 * they now sink to the bottom of their group rather than of the whole board.
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

function findRepo(name: string | undefined): RepoView | undefined {
    return name ? repos().find((repo) => repo.name === name) : undefined;
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
    return searchTerm.split(',').map((term) => term.trim()).filter(Boolean);
}

function matchesFilters(repo: RepoView): boolean {
    if (activeTab !== 'all' && repoTab(repo) !== activeTab) return false;
    if (groupFilter !== 'all' && repo.group !== groupFilter) return false;

    // Tags union rather than intersect: picking `backs` and `front` asks for
    // both sets, which is what "show me these groups" means. With the interface
    // hidden there is no way to clear a stored filter, so it must not apply.
    const active = tagsEnabled() ? state?.settings.activeTags ?? [] : [];
    if (active.length > 0 && !repo.tags.some((tag) => active.includes(tag))) return false;

    const terms = searchTerms();
    return terms.length === 0 || terms.some((term) => repo.name.toLowerCase().includes(term));
}

const stageHandlers: popover.StageHandlers = {
    openLog(stage, job) {
        const repo = findRepo(popover.openStage()?.repo);
        if (repo) openJobLog({ repo, stage, job, onRepo: applyRepo });
    },
    act(_stage, job, action) {
        const repoName = popover.openStage()?.repo;
        if (repoName) void runJobAction(repoName, job, action);
    },
};

const JOB_ACTION_VERB: Record<popover.JobAction, string> = {
    retry: 'Retrying',
    cancel: 'Cancelling',
    play: 'Starting',
};

/** Acts on a single job, then lets the refreshed row rebuild the popover. */
async function runJobAction(repoName: string, job: JobView, action: popover.JobAction): Promise<void> {
    // Manual jobs commonly deploy somewhere real, so starting one is confirmed.
    if (action === 'play') {
        const confirmed = await confirmDialog({
            title: 'Start job',
            message: `Start the manual job "${job.name}" in ${repoName}? Manual jobs often deploy to a real environment.`,
            confirmLabel: 'Start job',
        });
        if (!confirmed) return;
    }

    try {
        const result = action === 'retry'
            ? await api.retryJob(repoName, job.id)
            : action === 'cancel'
                ? await api.cancelJob(repoName, job.id)
                : await api.playJob(repoName, job.id);

        toastInfo(`${JOB_ACTION_VERB[action]} ${job.name}`);
        if (result.repo) applyRepo(result.repo);
    } catch (error) {
        toastError(error);
    }
}

const anchorFinder = (name: string) => (stage: string) =>
    rows.get(name)?.querySelector<HTMLElement>(
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
                    'aria-selected': String(activeTab === key),
                    onClick: () => {
                        activeTab = key;
                        renderTabs();
                        filtersChanged();
                    },
                },
                label,
                h('span', { class: 'count', text: String(counts.get(key) ?? 0) }),
            ),
        );
    }
}

function tags(): TagView[] {
    return state?.tags ?? [];
}

/**
 * The tag interface ships dark. Everything behind it — the store, the API, the
 * export format — is live regardless, so turning `CI_DECK_TAGS` on is the whole
 * switch and no data waits on it.
 */
function tagsEnabled(): boolean {
    return state?.meta.tagsEnabled === true;
}

/**
 * How many repos a scoped sweep would actually poll. Shown next to the toggle so
 * the saving is visible — the point of scoping is that watching two hundred
 * repos need not cost two hundred requests a pass.
 */
function sweptCount(): number {
    const settings = state?.settings;
    const covered = (repo: RepoView) =>
        !settings?.scopeSweepToTags
        || settings.activeTags.length === 0
        || repo.tags.some((tag) => settings.activeTags.includes(tag));

    return repos().filter((repo) => repo.watched && covered(repo)).length;
}

/** Repos the current filter shows, ignoring the tag part of it. */
function filterMatches(): RepoView[] {
    const terms = searchTerms();
    return repos().filter((repo) => {
        if (activeTab !== 'all' && repoTab(repo) !== activeTab) return false;
        if (groupFilter !== 'all' && repo.group !== groupFilter) return false;
        return terms.length === 0 || terms.some((term) => repo.name.toLowerCase().includes(term));
    });
}

async function applySettings(change: () => Promise<{ settings: Settings }>): Promise<void> {
    try {
        const { settings } = await change();
        if (state) state.settings = settings;
        renderTagbar();
        applyFilters();
    } catch (error) {
        toastError(error);
    }
}

/**
 * The filter is saved as an explicit membership list, not as a rule. Nothing is
 * inferred from the name — the search just spares you ticking sixty boxes once.
 */
async function saveFilterAsTag(): Promise<void> {
    const matches = filterMatches();
    const name = window.prompt(`Save these ${matches.length} repos as a tag named:`)?.trim();
    if (!name) return;

    try {
        await api.createTag(name).catch((error) => {
            // An existing name is fine: this replaces its membership.
            if (!String(error?.message ?? '').includes('already exists')) throw error;
        });
        const result = await api.setTagRepos(name, matches.map((repo) => repo.name));
        toastInfo(`${name}: ${result.repos.length} repo${result.repos.length === 1 ? '' : 's'}`);
        await reload();
    } catch (error) {
        toastError(error);
    }
}

function renderTagbar(): void {
    if (!tagsEnabled()) {
        tagbar.replaceChildren();
        return;
    }

    const active = state?.settings.activeTags ?? [];
    const matches = filterMatches();

    renderTagBar({
        container: tagbar,
        tags: tags(),
        active,
        scoped: state?.settings.scopeSweepToTags ?? false,
        scopeSummary: `${sweptCount()} of ${repos().filter((repo) => repo.watched).length}`,
        // Saving the current filter only means something when it is narrower than
        // the whole board and no tag is doing the narrowing already.
        saveable: active.length === 0 && matches.length > 0 && matches.length < repos().length,
        onToggle: (tag) => {
            const next = active.includes(tag) ? active.filter((entry) => entry !== tag) : [...active, tag];
            void applySettings(() => api.setActiveTags(next));
        },
        onClear: () => void applySettings(() => api.setActiveTags([])),
        onScope: (scoped) => void applySettings(() => api.setSweepScope(scoped)),
        onManage: () => openManageTags(repos(), tags(), () => void reload()),
        onSaveFilter: () => void saveFilterAsTag(),
    });
}

/**
 * Applies the filter and re-draws the tag bar with it, because what the bar
 * offers — "save this as a tag" — depends on how narrow the filter currently is.
 */
function filtersChanged(): void {
    applyFilters();
    renderTagbar();
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
    const previous = groupFilter;

    clear(groupSelect);
    groupSelect.appendChild(h('option', { value: 'all', text: 'All groups' }));
    for (const group of groups) {
        groupSelect.appendChild(h('option', { value: group, text: group }));
    }

    groupFilter = groups.includes(previous) ? previous : 'all';
    groupSelect.value = groupFilter;
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

function applyFilters(): void {
    let visible = 0;
    const shownPerGroup = new Map<string, number>();

    for (const [name, row] of rows) {
        const repo = findRepo(name);
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
}

function renderAll(): void {
    rows.clear();
    groupHeaders.clear();
    for (const section of [...board.querySelectorAll('tbody.group-body')]) section.remove();

    const openStage = popover.openStage();
    const now = Date.now();

    // One tbody per group, holding its heading and its rows. That is what keeps
    // the sticky heading bounded to its own section.
    for (const [group, members] of groupedRepos()) {
        const section = h('tbody', { class: 'group-body', 'data-group': group });

        const header = renderGroupHeader(group, members);
        groupHeaders.set(group, header);
        section.appendChild(header);

        for (const repo of members) {
            const row = renderRepo(repo, openStage, now, tagsEnabled());
            rows.set(repo.name, row);
            section.appendChild(row);
        }

        board.appendChild(section);
    }

    renderTabs();
    applyFilters();
    reattachPopover();
}

function replaceRow(repo: RepoView): void {
    const existing = rows.get(repo.name);

    // A row that is not on the board yet has no section to go under, and one
    // whose group changed is in the wrong one — either way, rebuild.
    if (!existing || !groupHeaders.has(repo.group)) {
        renderAll();
        return;
    }

    const row = renderRepo(repo, popover.openStage(), Date.now(), tagsEnabled());
    rows.set(repo.name, row);
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
    const index = state.repos.findIndex((entry) => entry.name === repo.name);
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
        sweepLabel.textContent = `checking ${sweep.index}/${sweep.total}${sweep.currentRepo ? ` · ${sweep.currentRepo}` : ''}`;
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

/** One place to swallow a whole new board, used by the SSE snapshot and reloads. */
function applyState(next: AppState): void {
    state = next;
    renderIntervals(next.settings.pollPeriodSeconds);
    renderGroups();
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
            break;
        case 'repo':
            applyRepo(event.repo);
            break;
        case 'sweep':
            if (!state) return;
            state.sweep = event.sweep;
            renderSweep();
            break;
        case 'settings':
            if (!state) return;
            state.settings = event.settings;
            if (document.activeElement !== intervalSelect) {
                renderIntervals(event.settings.pollPeriodSeconds);
            }
            renderTagbar();
            applyFilters();
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

async function onAction(action: string, target: HTMLElement): Promise<void> {
    const repoName = target.dataset.repo;
    const repo = findRepo(repoName);
    if (!repoName || !repo) return;

    if (action === 'stage') {
        const stage = repo.stages.find((entry) => entry.name === target.dataset.stage);
        if (stage) popover.toggle(target, repo, stage, stageHandlers);
        return;
    }

    if (action === 'edit-tags') {
        if (tagsEnabled()) openRepoTags(repo, tags(), () => void reload());
        return;
    }

    if (action === 'refresh-repo') {
        try {
            const result = await api.refreshRepo(repoName);
            if (result.repo) applyRepo(result.repo);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'retry-pipeline') {
        popover.close();
        try {
            const result = await api.retryPipeline(repoName);
            if (result.repo) applyRepo(result.repo);
            toastInfo(`Retrying failed jobs of ${repoName}`);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'cancel-pipeline') {
        popover.close();
        const confirmed = await confirmDialog({
            title: 'Cancel pipeline',
            message: `Cancel the running pipeline of ${repoName}? Jobs already finished stay as they are.`,
            confirmLabel: 'Cancel pipeline',
            danger: true,
        });
        if (!confirmed) return;

        try {
            const result = await api.cancelPipeline(repoName);
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
            await api.setWatched(repoName, watched);
            toastInfo(`${repoName} ${watched ? 'is being watched again' : 'paused — check it manually when needed'}`);
        } catch (error) {
            toastError(error);
        }
        return;
    }

    if (action === 'remove-repo') {
        popover.close();
        const confirmed = await confirmDialog({
            title: 'Remove repo',
            message: `Remove ${repoName} from the board entirely? To keep it but stop checking it periodically, pause it instead.`,
            confirmLabel: 'Remove',
            danger: true,
        });
        if (!confirmed) return;

        try {
            await api.removeRepo(repoName);
            toastInfo(`${repoName} removed from the board`);
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
});
window.addEventListener('scroll', () => {
    popover.position();
    scheduleStickyGroups();
}, true);

searchInput.addEventListener('input', () => {
    searchTerm = searchInput.value.trim().toLowerCase();
    filtersChanged();
});

groupSelect.addEventListener('change', () => {
    groupFilter = groupSelect.value;
    filtersChanged();
});

// Applied on select: an Apply button for one dropdown is a click nobody needs.
intervalSelect.addEventListener('change', () => {
    const seconds = Number.parseInt(intervalSelect.value, 10);
    const label = intervalSelect.selectedOptions[0]?.textContent ?? `${seconds}s`;

    api
        .setPollPeriod(seconds)
        .then(({ settings }) => {
            renderIntervals(settings.pollPeriodSeconds);
            toastInfo(`Checking every ${label}`);
        })
        .catch((error) => {
            if (state) renderIntervals(state.settings.pollPeriodSeconds);
            toastError(error);
        });
});

function openAddRepo(): void {
    const offered = tagsEnabled() ? tags() : null;
    addRepoDialog(state?.settings.defaultRef ?? 'main', offered, async ({ repo, ref, tags: wanted }) => {
        const result = await api.addRepo(repo, ref || undefined);
        if (wanted.length > 0) await api.setRepoTags(result.repo.name, wanted);
        toastInfo(`${result.repo.name} is now being watched`);
        if (wanted.length > 0) await reload();
    });
}

function openImport(): void {
    openImportDialog(repos(), () => void api.sweep().catch(() => undefined));
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
    title: 'Import or export the watch list',
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
