import type { RepoView, StageView } from '../src/shared/types.ts';
import { button, type ButtonTone } from './button.ts';
import { formatClock, formatRelative, h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import type { OpenStage } from './stage-popover.ts';
import { CANCELABLE, statusClass, statusIcon, statusKind, statusLabel } from './status.ts';

export type TabKey = 'all' | 'failed' | 'running' | 'passed' | 'other';

/**
 * Sized against the 22px bubble and the 24px badge. Every status icon is
 * normalised to fill the same share of its own box, so one number per place is
 * enough — the artwork does not have to be trusted to be evenly cropped.
 */
const BUBBLE_ICON = 15;
const BADGE_ICON = 13;

export function repoTab(repo: RepoView): Exclude<TabKey, 'all'> {
    if (repo.health === 'unreachable') return 'failed';
    const status = repo.pipeline?.status;
    if (!status) return 'other';
    const kind = statusKind(status);
    if (kind === 'failed') return 'failed';
    if (kind === 'running') return 'running';
    if (kind === 'success') return 'passed';
    return 'other';
}

/** An override carries its own icon; every badge says something different. */
interface BadgeOverride {
    label: string;
    className: string;
    icon: IconName;
}

function badge(status: string, override?: BadgeOverride): HTMLElement {
    return h(
        'span',
        { class: `badge ${override?.className ?? statusClass(status)}` },
        icon(override?.icon ?? statusIcon(statusKind(status)), BADGE_ICON),
        override?.label ?? statusLabel(status),
    );
}

/**
 * No "not checked by the scoped sweep" state here on purpose: the tag filter and
 * the sweep scope are one and the same list, so a row that is on screen is by
 * definition a row the sweep covers. Clearing the filter puts the rest back in
 * the sweep, and "waiting" is then the truth rather than a stuck spinner.
 */
function statusCell(repo: RepoView): HTMLElement {
    if (repo.health === 'unreachable') {
        return badge('failed', { label: 'Error', className: 's-failed', icon: 'status_warning' });
    }
    if (repo.health === 'no-pipeline') {
        return badge('created', { label: 'None', className: 's-neutral', icon: 'status_neutral' });
    }
    if (!repo.pipeline) {
        // A paused row will never be swept, so "waiting" would be a lie.
        return repo.watched
            ? h('span', { class: 'muted' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), ' waiting')
            : badge('created', { label: 'Paused', className: 's-paused', icon: 'pause' });
    }
    return badge(repo.pipeline.status);
}

/**
 * The row's tags, and the way to change them. Kept to two before it collapses to
 * a count — at the sizes this is built for a repo can carry half a dozen, and a
 * row that wraps to fit them all is worse than one that says "+4".
 */
function tagsCluster(repo: RepoView): HTMLElement {
    const shown = repo.tags.slice(0, 2);
    const extra = repo.tags.length - shown.length;

    return h(
        'button',
        {
            type: 'button',
            class: `repo-tags${repo.tags.length === 0 ? ' repo-tags-empty' : ''}`,
            'data-action': 'edit-tags',
            'data-repo': repo.name,
            title: repo.tags.length > 0 ? `Tags: ${repo.tags.join(', ')}` : `Add tags to ${repo.name}`,
            'aria-label': repo.tags.length > 0
                ? `Tags of ${repo.name}: ${repo.tags.join(', ')}`
                : `Add tags to ${repo.name}`,
        },
        ...shown.map((tag) => h('span', { class: 'tag-chip', text: tag })),
        extra > 0 ? h('span', { class: 'tag-chip tag-chip-more', text: `+${extra}` }) : null,
        repo.tags.length === 0 ? icon('tag', 12) : null,
    );
}

function repoCell(repo: RepoView, showTags: boolean): HTMLElement {
    const name = repo.webUrl
        ? h('a', {
            class: 'repo-name',
            href: `${repo.webUrl}/-/pipelines`,
            target: '_blank',
            rel: 'noreferrer',
            text: repo.name,
            title: repo.name,
        })
        : h('span', { class: 'repo-name', text: repo.name, title: repo.name });

    return h(
        'div',
        {},
        name,
        h(
            'span',
            { class: 'repo-sub' },
            h('span', { class: 'chip', text: repo.group }),
            h('span', { class: 'repo-ref', text: repo.ref }),
            showTags ? tagsCluster(repo) : null,
            // Paused rows keep their last known status in the badge — that is the
            // point of pausing rather than removing — so the pause itself is said
            // here instead, in amber, and is not dimmed with the rest of the row.
            repo.watched
                ? null
                : h('span', { class: 'paused-flag' }, icon('pause', 11), h('span', { text: 'Paused' })),
            // Beside the name rather than in the commit cell, which is the first
            // column to go on a narrow window — this is the last thing to lose.
            failureHint(repo),
            repo.checking ? h('span', { class: 'spinner', 'aria-label': 'checking' }) : null,
        ),
    );
}

function pipelineCell(repo: RepoView): HTMLElement {
    if (repo.health === 'unreachable') {
        return h('span', { class: 'error-text', text: '!', title: repo.lastError ?? 'unreachable' });
    }
    if (!repo.pipeline) return h('span', { class: 'muted', text: '—' });

    return h('a', {
        class: 'mono',
        href: repo.pipeline.webUrl,
        target: '_blank',
        rel: 'noreferrer',
        text: `#${repo.pipeline.iid}`,
        title: `#${repo.pipeline.iid} · ${repo.pipeline.source.replace(/_/g, ' ')} · ${repo.pipeline.ref}`,
    });
}

/**
 * The names behind a red row. A failed row otherwise says only "something in
 * `test` broke", and the answer is two clicks away in the stage popover.
 * `allow_failure` jobs are left out — they are why a stage is amber, not red.
 */
export function failedJobNames(repo: RepoView): string[] {
    return repo.stages.flatMap((stage) =>
        stage.jobs.filter((job) => job.status === 'failed' && !job.allowFailure).map((job) => job.name),
    );
}

function failureHint(repo: RepoView): HTMLElement | null {
    const failed = failedJobNames(repo);
    if (failed.length === 0) return null;

    const text = failed.length === 1
        ? `${failed[0]} failed`
        : `${failed[0]} +${failed.length - 1} failed`;

    return h('span', { class: 'fail-hint', text, title: `failed: ${failed.join(', ')}` });
}

function commitCell(repo: RepoView): HTMLElement {
    if (repo.health === 'unreachable') {
        return h('span', {
            class: 'error-text',
            text: repo.lastError ?? 'unreachable',
            title: repo.lastError ?? '',
        });
    }
    if (!repo.pipeline) return h('span', { class: 'muted', text: '—' });

    const commit = repo.pipeline.commit;
    const sha = repo.webUrl
        ? h('a', {
            class: 'mono',
            href: `${repo.webUrl}/-/commit/${repo.pipeline.sha}`,
            target: '_blank',
            rel: 'noreferrer',
            text: repo.pipeline.sha.slice(0, 8),
        })
        : h('span', { class: 'mono', text: repo.pipeline.sha.slice(0, 8) });

    return h(
        'div',
        {},
        h('span', { class: 'commit-title', text: commit?.title ?? '', title: commit?.title ?? '' }),
        h('span', { class: 'repo-sub' }, sha, commit ? h('span', { text: commit.authorName }) : null),
    );
}

function stageBubble(repo: RepoView, stage: StageView, expanded: boolean): HTMLElement {
    const failing = stage.jobs.filter((job) => job.status === 'failed').map((job) => job.name);
    const title = [
        `${stage.name}: ${statusLabel(stage.status)}`,
        `${stage.jobs.length} job${stage.jobs.length === 1 ? '' : 's'}`,
        failing.length > 0 ? `failed: ${failing.join(', ')}` : '',
    ]
        .filter(Boolean)
        .join(' · ');

    return h(
        'button',
        {
            type: 'button',
            class: `bubble ${statusClass(stage.status)}`,
            'data-action': 'stage',
            'data-repo': repo.name,
            'data-stage': stage.name,
            'aria-expanded': String(expanded),
            'aria-label': title,
            title,
        },
        icon(statusIcon(statusKind(stage.status)), BUBBLE_ICON),
    );
}

function stagesCell(repo: RepoView, openStage: OpenStage | null): HTMLElement {
    if (repo.stages.length === 0) return h('span', { class: 'muted', text: '—' });

    const wrapper = h('div', { class: 'stages' });
    repo.stages.forEach((stage, index) => {
        if (index > 0) wrapper.appendChild(h('span', { class: 'stage-link', text: '–', 'aria-hidden': 'true' }));
        const expanded = openStage?.repo === repo.name && openStage.stage === stage.name;
        wrapper.appendChild(stageBubble(repo, stage, expanded));
    });
    return wrapper;
}

function timeCell(repo: RepoView, now: number): HTMLElement {
    return h(
        'div',
        {},
        h('span', {
            text: repo.pipeline ? formatRelative(repo.pipeline.updatedAt, now) : '',
            title: repo.pipeline?.updatedAt ?? '',
        }),
        h('span', {
            class: 'repo-sub',
            text: repo.lastCheckedAt ? `checked ${formatClock(repo.lastCheckedAt)}` : '',
        }),
    );
}

function actionsCell(repo: RepoView): HTMLElement {
    const status = repo.pipeline?.status;
    const canCancel = Boolean(status && CANCELABLE.has(status));
    const canRetry = Boolean(status && !CANCELABLE.has(status));

    // Clicks are handled by delegation on the board, hence data attributes.
    const action = (
        name: string,
        iconName: IconName,
        label: string,
        options: { disabled?: boolean; tone?: ButtonTone } = {},
    ) =>
        button({
            label,
            icon: iconName,
            tone: options.tone,
            disabled: options.disabled ?? false,
            data: { action: name, repo: repo.name },
        });

    return h(
        'div',
        { class: 'actions actions-end' },
        h(
            'span',
            { class: 'action-group' },
            action('refresh-repo', 'refresh', `Check ${repo.name} now`, {
                disabled: repo.checking,
                tone: 'info',
            }),
        ),
        h(
            'span',
            { class: 'action-group' },
            action('retry-pipeline', 'retry', `Retry failed jobs of ${repo.name}`, {
                disabled: !canRetry,
                tone: 'info',
            }),
            action('cancel-pipeline', 'cancel', `Cancel pipeline of ${repo.name}`, {
                disabled: !canCancel,
                tone: 'danger',
            }),
        ),
        h(
            'span',
            { class: 'action-group' },
            repo.watched
                ? action('unwatch-repo', 'watched', `Pause watching ${repo.name}`, { tone: 'positive' })
                : action('watch-repo', 'unwatched', `Resume watching ${repo.name}`, { tone: 'muted' }),
            action('remove-repo', 'trash', `Remove ${repo.name} from the board`, { tone: 'danger' }),
        ),
    );
}

/**
 * A section heading, as a row inside its group's own `tbody`. That grouping is
 * what bounds the sticky heading: a heading in a `tbody` of its own would have
 * nothing to constrain it and would stay pinned for the rest of the table, so
 * every section that had scrolled past would pile up at the same offset.
 */
export function renderGroupHeader(group: string, repos: RepoView[]): HTMLTableRowElement {
    const failed = repos.filter((repo) => repoTab(repo) === 'failed').length;

    return h(
        'tr',
        { class: 'group', 'data-group': group },
        h(
            'td',
            // `h` assigns properties, so this is the DOM name, not the attribute.
            { colSpan: 7 },
            h(
                'div',
                { class: 'group-head' },
                h('span', { class: 'group-name', text: group }),
                h('span', {
                    class: 'group-count',
                    text: `${repos.length} repo${repos.length === 1 ? '' : 's'}`,
                }),
                failed > 0 ? h('span', { class: 'group-failed', text: `${failed} failed` }) : null,
            ),
        ),
    );
}

/** One row per repo, swapped on its own so a check never re-renders its neighbours. */
export function renderRepo(
    repo: RepoView,
    openStage: OpenStage | null,
    now: number,
    /** The tag interface ships dark; the rows follow it. */
    showTags = false,
): HTMLTableRowElement {
    return h(
        'tr',
        { class: `repo${repo.watched ? '' : ' repo-paused'}`, 'data-repo': repo.name },
        // The classes match the header cells so one media query can drop a whole
        // column instead of counting `nth-child` positions.
        h('td', { class: 'col-status' }, statusCell(repo)),
        h('td', { class: 'col-repo' }, repoCell(repo, showTags)),
        h('td', { class: 'col-pipeline' }, pipelineCell(repo)),
        h('td', { class: 'col-commit' }, commitCell(repo)),
        h('td', { class: 'col-stages' }, stagesCell(repo, openStage)),
        h('td', { class: 'col-time' }, timeCell(repo, now)),
        h('td', { class: 'col-actions' }, actionsCell(repo)),
    );
}
