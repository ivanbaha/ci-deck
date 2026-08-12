import type { NotifyMode, RepoView, StageView } from '../src/shared/types.ts';
import { button, type ButtonTone } from './button.ts';
import { formatAbsolute, formatClock, formatRelative, h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import type { OpenStage } from './stage-popover.ts';
import { CANCELABLE, statusClass, statusIcon, statusKind, statusLabel } from './status.ts';
import { tagChip, tagLine } from './tag-style.ts';

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

/**
 * The pill, and what is behind it. `tip` is the detail the row no longer spells
 * out — the names that failed, the error that could not be reached — hung off
 * the one thing on the row that already says something went wrong.
 */
function badge(status: string, override?: BadgeOverride, tip?: Tip | null): HTMLElement {
    const label = override?.label ?? statusLabel(status);

    return h(
        'span',
        {
            class: `badge ${override?.className ?? statusClass(status)}`,
            'data-tip': tip?.body ?? null,
            'data-tip-title': tip?.title ?? null,
            // A span is not focusable, so the tooltip is the pointer's alone. The
            // label carries the same words for anything reading the row aloud.
            'aria-label': tip ? `${label} — ${tip.body.replace(/\n/g, ', ')}` : null,
        },
        icon(override?.icon ?? statusIcon(statusKind(status)), BADGE_ICON),
        label,
    );
}

/**
 * No "not checked by a narrowed sweep" state here on purpose: the sweep covers
 * every watched repo whatever the board is filtered to, so a row that is on
 * screen is a row being checked and so is every row that is not.
 */
function statusCell(repo: RepoView): HTMLElement {
    if (repo.health === 'unreachable') {
        return badge(
            'failed',
            { label: 'Error', className: 's-failed', icon: 'status_warning' },
            repo.lastError ? { title: 'Cannot be reached', body: repo.lastError } : null,
        );
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
    return badge(repo.pipeline.status, undefined, failureTip(repo));
}

/**
 * What the row carries, and only that. Kept to two before it collapses to a
 * count — at the sizes this is built for a repo can carry half a dozen, and a
 * row that wraps to fit them all is worse than one that says "+4".
 *
 * Not a control. Which repos carry a tag is set in Configuration → Tags, or on
 * the way in when a repo is added; a row with nothing on it shows nothing.
 */
function tagsCluster(repo: RepoView): HTMLElement | null {
    if (repo.tags.length === 0) return null;

    const shown = repo.tags.slice(0, 2);
    const hidden = repo.tags.slice(shown.length);

    return h(
        'span',
        { class: 'repo-tags' },
        ...shown.map((tag) => tagChip(tag)),
        // The count stands in for the tags it hides, so it says which they are.
        hidden.length > 0
            ? h('span', {
                class: 'tag-chip tag-chip-more',
                text: `+${hidden.length}`,
                'data-tip-title': `${hidden.length} more`,
                'data-tip': hidden.map(tagLine).join('\n'),
            })
            : null,
    );
}

function repoCell(repo: RepoView): HTMLElement {
    // The group heads the tip: it is the one thing about a row that the row
    // itself stopped saying once the section headings took it over.
    const tip = { 'data-tip-title': repo.group, 'data-tip': repo.name };
    const name = repo.webUrl
        ? h('a', {
            class: 'repo-name',
            href: `${repo.webUrl}/-/pipelines?ref=${encodeURIComponent(repo.ref)}`,
            target: '_blank',
            rel: 'noreferrer',
            text: repo.name,
            ...tip,
        })
        : h('span', { class: 'repo-name', text: repo.name, ...tip });

    return h(
        'div',
        {},
        h(
            'span',
            { class: 'repo-head' },
            name,
            // The branch belongs to the name, not to the tags: two rows for one
            // repo differ only here. Long ones clip, so the whole ref is a hover
            // away — a `refs/heads/feature/…` name is otherwise unreadable.
            h(
                'span',
                {
                    class: 'chip repo-ref',
                    'data-tip-title': 'Branch',
                    'data-tip': repo.branchMissing
                        ? `${repo.ref}\nNo longer exists on GitLab.`
                        : repo.ref,
                },
                icon('branch', 10),
                // The name clips, not the chip: an ellipsis where the branch runs
                // out of room, with the glyph still on the left of it.
                h('span', { class: 'repo-ref-name', text: repo.ref }),
            ),
        ),
        h(
            'span',
            { class: 'repo-sub' },
            h('span', { class: 'chip', text: repo.group }),
            // Paused rows keep their last known status in the badge — that is the
            // point of pausing rather than removing — so the pause itself is said
            // here instead, in amber, and is not dimmed with the rest of the row.
            repo.watched
                ? null
                : h('span', { class: 'paused-flag' }, icon('pause', 11), h('span', { text: 'Paused' })),
            // A branch that has been merged and deleted leaves a row that can never
            // go green again. Saying so beats leaving it looking merely quiet.
            repo.branchMissing
                ? h('span', {
                    class: 'gone-flag',
                    'data-tip-title': 'Branch gone',
                    'data-tip': `${repo.ref} is gone from GitLab.\nThis row can be removed.`,
                }, icon('status_warning', 11), h('span', { text: 'Branch gone' }))
                : null,
            // The line the tags now have to themselves, so a long list of them
            // stops pushing the flags beside it off the row.
            tagsCluster(repo),
            repo.checking ? h('span', { class: 'spinner', 'aria-label': 'checking' }) : null,
        ),
    );
}

function pipelineCell(repo: RepoView): HTMLElement {
    if (repo.health === 'unreachable') {
        return h('span', {
            class: 'error-text',
            text: '!',
            'data-tip-title': 'Cannot be reached',
            'data-tip': repo.lastError ?? 'unreachable',
        });
    }
    if (!repo.pipeline) return h('span', { class: 'muted', text: '—' });

    return h('a', {
        class: 'mono',
        href: repo.pipeline.webUrl,
        target: '_blank',
        rel: 'noreferrer',
        text: `#${repo.pipeline.iid}`,
        'data-tip-title': `Pipeline #${repo.pipeline.iid}`,
        'data-tip': `${repo.pipeline.source.replace(/_/g, ' ')} on ${repo.pipeline.ref}`,
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

/** A tooltip's two halves: a heading, and the text under it. */
interface Tip {
    title: string;
    body: string;
}

/**
 * The names behind a red row, as a hover on the pill rather than words on the
 * row. Nine failed jobs used to be "lint +8 failed" and a `title` attribute;
 * here the whole list fits, and the row keeps the space for its tags.
 */
function failureTip(repo: RepoView): Tip | null {
    const failed = failedJobNames(repo);
    if (failed.length === 0) return null;

    return {
        title: failed.length === 1 ? '1 job failed' : `${failed.length} jobs failed`,
        body: failed.join('\n'),
    };
}

function commitCell(repo: RepoView): HTMLElement {
    if (repo.health === 'unreachable') {
        return h('span', {
            class: 'error-text',
            text: repo.lastError ?? 'unreachable',
            'data-tip-title': 'Cannot be reached',
            'data-tip': repo.lastError ?? null,
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
        // One line on the row; the tip is where a long subject can be read.
        h('span', { class: 'commit-title', text: commit?.title ?? '', 'data-tip': commit?.title ?? null }),
        h('span', { class: 'repo-sub' }, sha, commit ? h('span', { text: commit.authorName }) : null),
    );
}

/**
 * One bubble per stage, and two marks for what the bubble could not also say.
 *
 * The status is the worst thing in the stage, which is the right headline and a
 * poor summary: a stage that is red because one job broke and also holds a manual
 * deploy showed no sign of the deploy at all. So the dashed border — already this
 * board's mark for "not run, but it could be" — is borrowed for any stage holding
 * a manual job, and an amber dot marks one where something failed and was allowed
 * to. Both compose with whatever colour the headline is.
 */
function stageBubble(repo: RepoView, stage: StageView, expanded: boolean): HTMLElement {
    const failing = stage.jobs.filter((job) => job.status === 'failed').map((job) => job.name);
    const marksManual = stage.hasManual && stage.status !== 'manual';
    const marksWarning = stage.hasWarning && stage.status !== 'warning' && stage.status !== 'failed';

    const lines = [
        `${stage.jobs.length} job${stage.jobs.length === 1 ? '' : 's'}`,
        failing.length > 0 ? `Failed: ${failing.join(', ')}` : '',
        marksManual ? 'Has a manual job' : '',
        marksWarning ? 'A job failed but was allowed to' : '',
    ].filter(Boolean);

    const heading = `${stage.name}: ${statusLabel(stage.status)}`;

    return h(
        'button',
        {
            type: 'button',
            class: [
                'bubble',
                statusClass(stage.status),
                marksManual ? 'has-manual' : '',
                marksWarning ? 'has-warn' : '',
            ].filter(Boolean).join(' '),
            'data-action': 'stage',
            'data-repo': String(repo.id),
            'data-stage': stage.name,
            'aria-expanded': String(expanded),
            'aria-label': [heading, ...lines].join(' · '),
            'data-tip-title': heading,
            'data-tip': lines.join('\n'),
        },
        icon(statusIcon(statusKind(stage.status)), BUBBLE_ICON),
    );
}

function stagesCell(repo: RepoView, openStage: OpenStage | null): HTMLElement {
    if (repo.stages.length === 0) return h('span', { class: 'muted', text: '—' });

    const wrapper = h('div', { class: 'stages' });
    repo.stages.forEach((stage, index) => {
        if (index > 0) wrapper.appendChild(h('span', { class: 'stage-link', text: '–', 'aria-hidden': 'true' }));
        const expanded = openStage?.repo === repo.id && openStage.stage === stage.name;
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
            'data-tip-title': repo.pipeline?.updatedAt ? 'Updated' : null,
            // "23m ago" is the useful form on the row; the tip is where the
            // actual moment lives, in the reader's own clock rather than UTC.
            'data-tip': formatAbsolute(repo.pipeline?.updatedAt ?? null),
        }),
        h('span', {
            class: 'repo-sub',
            text: repo.lastCheckedAt ? `checked ${formatClock(repo.lastCheckedAt)}` : '',
        }),
    );
}

const NOTIFY_ICON: Record<NotifyMode, IconName> = {
    on: 'bell',
    snooze: 'bell_snooze',
    off: 'bell_off',
};

const NOTIFY_TONE: Record<NotifyMode, ButtonTone> = {
    on: 'positive',
    snooze: 'caution',
    off: 'muted',
};

const NOTIFY_WORDS: Record<NotifyMode, string> = {
    on: 'notifies with a sound',
    snooze: 'notifies silently',
    off: 'says nothing',
};

/** One button through three states, the way the eye beside it is one for two. */
function notifyLabel(repo: RepoView, globalMode: NotifyMode): string {
    if (globalMode === 'off') return 'Notifications are switched off for the whole board, in Configuration';
    const suffix = globalMode === 'snooze' ? ' — the board is snoozed, so no sound either way' : '';
    return `${repo.name} ${NOTIFY_WORDS[repo.notify]} — click to change${suffix}`;
}

function actionsCell(repo: RepoView, globalMode: NotifyMode): HTMLElement {
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
            data: { action: name, repo: String(repo.id) },
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
            action('cycle-notify', NOTIFY_ICON[repo.notify], notifyLabel(repo, globalMode), {
                disabled: globalMode === 'off',
                tone: NOTIFY_TONE[repo.notify],
            }),
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
                    text: `${repos.length} row${repos.length === 1 ? '' : 's'}`,
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
    globalNotify: NotifyMode,
): HTMLTableRowElement {
    const classes = [
        'repo',
        repo.watched ? '' : 'repo-paused',
        repo.branchMissing ? 'repo-gone' : '',
    ].filter(Boolean).join(' ');

    return h(
        'tr',
        { class: classes, 'data-repo': String(repo.id) },
        // The classes match the header cells so one media query can drop a whole
        // column instead of counting `nth-child` positions.
        h('td', { class: 'col-status' }, statusCell(repo)),
        h('td', { class: 'col-repo' }, repoCell(repo)),
        h('td', { class: 'col-pipeline' }, pipelineCell(repo)),
        h('td', { class: 'col-commit' }, commitCell(repo)),
        h('td', { class: 'col-stages' }, stagesCell(repo, openStage)),
        h('td', { class: 'col-time' }, timeCell(repo, now)),
        h('td', { class: 'col-actions' }, actionsCell(repo, globalNotify)),
    );
}
