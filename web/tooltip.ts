import { h } from './dom.ts';

/**
 * One tooltip for the whole board, driven by `data-tip`.
 *
 * A single node parked on the body rather than one per anchor, for the same
 * reason the stage popover lives there: a row is rebuilt under the pointer on
 * every sweep, and a tooltip inside that row would be torn out mid-read. Here
 * the anchor is only ever read from, so the row can go and the tip notices.
 *
 * `data-tip` is the body — newlines are kept, so a list needs no markup — and
 * `data-tip-title` is an optional heading above it.
 */

/** Clear of the pointer, and matched to the popover's own offsets. */
const GAP = 8;
const VIEWPORT_MARGIN = 8;

/** Long enough that sweeping across a row of pills shows nothing at all. */
const OPEN_DELAY_MS = 140;

/** How often a shown tip checks that the row it belongs to is still there. */
const ALIVE_POLL_MS = 250;

let element: HTMLElement | null = null;
let anchor: HTMLElement | null = null;
let openTimer: ReturnType<typeof setTimeout> | null = null;
let aliveTimer: ReturnType<typeof setInterval> | null = null;
/** Set between a mousemove and the frame that answers it. */
let moving = false;

function tipOf(node: EventTarget | null): HTMLElement | null {
    return node instanceof Element ? node.closest<HTMLElement>('[data-tip]') : null;
}

/**
 * The one thing the browser's own tooltip did that events cannot: a disabled
 * control gets no mouse events at all — they are dispatched to its parent — so
 * hovering the greyed-out Retry would otherwise say nothing about why it is
 * greyed out. When the parent under the pointer holds one, the point decides
 * what the target could not.
 *
 * The `:disabled` test keeps the hit test off the rest of the board: everything
 * else is answered by `closest` on the target, which costs nothing.
 */
function disabledTipAt(event: MouseEvent): HTMLElement | null {
    const holder = event.target;
    if (!(holder instanceof Element) || !holder.querySelector(':scope > [data-tip]:disabled')) {
        return null;
    }
    return tipOf(document.elementFromPoint(event.clientX, event.clientY));
}

export function hideTip(): void {
    if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
    }
    if (aliveTimer) {
        clearInterval(aliveTimer);
        aliveTimer = null;
    }
    element?.remove();
    element = null;
    anchor = null;
}

/** Above the anchor, centred; below it when the top of the window is closer. */
export function positionTip(): void {
    if (!element || !anchor) return;
    if (!anchor.isConnected) {
        hideTip();
        return;
    }

    const box = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();

    const above = box.top - size.height - GAP;
    const top = above >= VIEWPORT_MARGIN
        ? above
        : Math.min(box.bottom + GAP, window.innerHeight - size.height - VIEWPORT_MARGIN);

    const left = Math.min(
        Math.max(box.left + box.width / 2 - size.width / 2, VIEWPORT_MARGIN),
        window.innerWidth - size.width - VIEWPORT_MARGIN,
    );

    element.style.top = `${Math.max(VIEWPORT_MARGIN, top)}px`;
    element.style.left = `${Math.max(VIEWPORT_MARGIN, left)}px`;
}

function show(next: HTMLElement): void {
    const body = next.getAttribute('data-tip');
    if (!body) return;

    const title = next.getAttribute('data-tip-title');
    element = h(
        'div',
        { class: 'tooltip', role: 'tooltip' },
        title ? h('span', { class: 'tooltip-title', text: title }) : null,
        h('span', { class: 'tooltip-body', text: body }),
    );

    document.body.appendChild(element);
    anchor = next;
    positionTip();
    aliveTimer = setInterval(() => {
        if (!anchor?.isConnected) hideTip();
    }, ALIVE_POLL_MS);
}

function schedule(next: HTMLElement | null, delay = OPEN_DELAY_MS): void {
    // Already on it — moving between an anchor's own children is not a move.
    if (next !== null && next === anchor) return;

    hideTip();
    if (next) openTimer = setTimeout(() => show(next), delay);
}

/** Wired once, on the document: the rows it serves are replaced constantly. */
export function initTooltips(): void {
    // `mouseover` alone covers the move from one anchor to another and the move
    // off an anchor onto anything else; only leaving the window entirely is
    // silent, and that is what a null `relatedTarget` means.
    document.addEventListener('mouseover', (event) => schedule(tipOf(event.target)));
    document.addEventListener('mouseout', (event) => {
        if (event.relatedTarget === null) schedule(null);
    });
    // A disabled control is silent, so its own patch of the row is watched by
    // hand. Once per frame at most: the hit test below reads layout.
    document.addEventListener('mousemove', (event) => {
        if (tipOf(event.target) || moving) return;
        moving = true;
        requestAnimationFrame(() => {
            moving = false;
            schedule(disabledTipAt(event));
        });
    });
    // Keyboard gets the same text, without the delay — reaching it took intent.
    // Only when the focus ring is showing, or opening a dialog would pop a tip
    // on whatever it focused.
    document.addEventListener('focusin', (event) => {
        const next = tipOf(event.target);
        if (next?.matches(':focus-visible')) schedule(next, 0);
    });
    document.addEventListener('focusout', () => schedule(null));
    // A click is about to change something; a tip left over it is stale by then.
    document.addEventListener('mousedown', hideTip, true);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') hideTip();
    });

    window.addEventListener('scroll', positionTip, true);
    window.addEventListener('resize', positionTip);
}
