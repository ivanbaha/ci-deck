import type { JobView, RepoView, StageView } from '../src/shared/types.ts';
import { button, type ButtonTone } from './button.ts';
import { formatDuration, h } from './dom.ts';
import { icon, type IconName } from './icons.ts';
import { CANCELABLE, RETRYABLE, statusClass, statusIcon, statusKind, statusLabel } from './status.ts';

/** Matches `.bubble-sm`, which is 16px across. */
const SMALL_BUBBLE_ICON = 11;

function smallBubble(status: string): HTMLElement {
    return h(
        'span',
        { class: `bubble bubble-sm ${statusClass(status)}` },
        icon(statusIcon(statusKind(status)), SMALL_BUBBLE_ICON),
    );
}

export interface OpenStage {
    repo: string;
    stage: string;
}

export type JobAction = 'retry' | 'cancel' | 'play';

export interface StageHandlers {
    openLog(stage: string, job: JobView): void;
    act(stage: string, job: JobView, action: JobAction): void;
}

interface ActivePopover extends OpenStage {
    element: HTMLElement;
    anchor: HTMLElement;
}

const GAP = 6;
const VIEWPORT_MARGIN = 8;

let active: ActivePopover | null = null;
let handlers: StageHandlers | null = null;

export function openStage(): OpenStage | null {
    return active ? { repo: active.repo, stage: active.stage } : null;
}

/** One control per job, chosen by its status — the others would never apply. */
function actionFor(job: JobView): { action: JobAction; icon: IconName; label: string; tone: ButtonTone } | null {
    if (CANCELABLE.has(job.status)) {
        return { action: 'cancel', icon: 'cancel', label: `Cancel ${job.name}`, tone: 'danger' };
    }
    if (job.status === 'manual') {
        return { action: 'play', icon: 'play', label: `Start ${job.name}`, tone: 'positive' };
    }
    if (RETRYABLE.has(job.status)) {
        return { action: 'retry', icon: 'retry', label: `Retry ${job.name}`, tone: 'info' };
    }
    return null;
}

function jobRow(stage: StageView, job: JobView): HTMLElement {
    const meta = [
        statusLabel(job.status),
        formatDuration(job.durationSeconds),
        job.retriedAttempts > 0 ? `${job.retriedAttempts + 1} attempts` : '',
        job.allowFailure && job.status === 'failed' ? 'allowed to fail' : '',
    ]
        .filter(Boolean)
        .join(' · ');

    const open = h(
        'button',
        { type: 'button', class: 'job', title: `${job.name} — ${meta}\nClick to read the log` },
        smallBubble(job.status),
        h('span', { class: 'job-name', text: job.name }),
        h('span', { class: 'job-meta', text: meta }),
    );
    open.addEventListener('click', () => handlers?.openLog(stage.name, job));

    // The control sits outside the log button: nested buttons are invalid.
    const choice = actionFor(job);
    const actions = h(
        'span',
        { class: 'job-actions' },
        choice
            ? button({
                label: choice.label,
                icon: choice.icon,
                tone: choice.tone,
                small: true,
                onClick: () => handlers?.act(stage.name, job, choice.action),
            })
            : h('span', { class: 'job-action-empty', 'aria-hidden': 'true' }),
    );

    return h('div', { class: `job-row ${statusClass(job.status)}` }, open, actions);
}

function buildContent(repo: RepoView, stage: StageView): HTMLElement {
    const list = h('div', { class: 'jobs-list' });
    for (const job of stage.jobs) list.appendChild(jobRow(stage, job));

    return h(
        'div',
        { class: 'popover', role: 'dialog', 'aria-label': `${stage.name} jobs of ${repo.name}` },
        h(
            'div',
            { class: 'popover-head' },
            smallBubble(stage.status),
            h('h3', { class: 'popover-title', text: `${stage.name} · ${statusLabel(stage.status)}` }),
        ),
        list,
    );
}

/** Anchors below the bubble, flipping above and clamping when space runs out. */
export function position(): void {
    if (!active) return;
    const { element, anchor } = active;

    if (!anchor.isConnected) {
        close();
        return;
    }

    const box = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    const spaceBelow = window.innerHeight - box.bottom;

    const top = spaceBelow >= size.height + GAP || box.top < size.height + GAP
        ? Math.min(box.bottom + GAP, window.innerHeight - size.height - VIEWPORT_MARGIN)
        : box.top - size.height - GAP;

    const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(box.left, window.innerWidth - size.width - VIEWPORT_MARGIN),
    );

    element.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
    element.style.left = `${left}px`;
}

export function close(): void {
    if (!active) return;
    active.anchor.setAttribute('aria-expanded', 'false');
    active.element.remove();
    active = null;
}

export function toggle(
    anchor: HTMLElement,
    repo: RepoView,
    stage: StageView,
    stageHandlers: StageHandlers,
): void {
    const wasOpen = active?.repo === repo.name && active.stage === stage.name;
    close();
    if (wasOpen) return;

    handlers = stageHandlers;
    const element = buildContent(repo, stage);
    document.body.appendChild(element);
    anchor.setAttribute('aria-expanded', 'true');
    active = { repo: repo.name, stage: stage.name, element, anchor };
    position();
}

/**
 * Re-attaches an open popover after its row was re-rendered; the old anchor node
 * is gone by then, so the bubble is looked up again.
 */
export function reattach(
    repo: RepoView,
    findAnchor: (stageName: string) => HTMLElement | null,
    stageHandlers: StageHandlers,
): void {
    if (!active || active.repo !== repo.name) return;

    const stage = repo.stages.find((entry) => entry.name === active!.stage);
    const anchor = findAnchor(active.stage);
    if (!stage || !anchor) {
        close();
        return;
    }

    const element = buildContent(repo, stage);
    active.element.replaceWith(element);
    anchor.setAttribute('aria-expanded', 'true');
    handlers = stageHandlers;
    active = { repo: repo.name, stage: stage.name, element, anchor };
    position();
}

export function isInside(node: Node | null): boolean {
    return Boolean(active && node && active.element.contains(node));
}
