import { COLUMN_KEYS, MIN_COLUMN_WIDTH, type ColumnKey } from '../src/shared/types.ts';
import { h } from './dom.ts';

/**
 * Column widths, dragged from the header and kept in the database.
 *
 * The table's width is whatever the page gives it and never more: the row
 * controls hold a fixed column, and the rest divide up what is left. So a handle
 * does not make the board wider — it trades width between the two columns either
 * side of it, one growing by exactly what the other gives up, until the one
 * shrinking reaches the floor and the handle stops.
 *
 * That is why there are five handles for six columns. A sixth, on the right of
 * the last one, would have nothing to trade with but the fixed column beside it.
 *
 * Widths are set as custom properties on the table rather than on each cell, so
 * one write moves a whole column: the header and every row read the same
 * variable. What is stored is a weight rather than a measurement — the layout
 * scales them to the room actually available, so a narrower window keeps the
 * proportions instead of overflowing.
 */
export interface ColumnResizer {
    /** Lays stored widths out across the room the table has. */
    apply(widths: Record<ColumnKey, number>): void;
    /** Runs that layout again, for when the window changed size. */
    relayout(): void;
}

/** Every column but the last: the handle sits on a column's right-hand edge. */
const HANDLE_KEYS = COLUMN_KEYS.slice(0, -1);

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high);

export function columnResizer(
    table: HTMLTableElement,
    /** Called once the drag ends, so a drag is one write rather than sixty. */
    onCommit: (widths: Partial<Record<ColumnKey, number>>) => void,
): ColumnResizer {
    /** What the user set, in the room they set it in. */
    let stored = {} as Record<ColumnKey, number>;
    /** What is on screen now, which is those weights fitted to this window. */
    let laid = {} as Record<ColumnKey, number>;

    const headerOf = (key: ColumnKey) => table.querySelector<HTMLElement>(`thead th.col-${key}`);

    /** The commit column is dropped entirely on a narrow window. */
    const shownKeys = () =>
        COLUMN_KEYS.filter((key) => {
            const header = headerOf(key);
            return header !== null && getComputedStyle(header).display !== 'none';
        });

    /**
     * The width the locked column is *given*, not the width it happens to have.
     * Measuring it is circular: a table whose columns do not yet add up has the
     * difference spread across all of them, so a measurement taken mid-layout
     * feeds the wrong number back into the next one.
     */
    const lockedWidth = () =>
        Number.parseFloat(getComputedStyle(table).getPropertyValue('--col-actions')) || 0;

    const setWidth = (key: ColumnKey, width: number) => {
        laid[key] = width;
        table.style.setProperty(`--col-${key}`, `${width}px`);
    };

    function layout(): void {
        const keys = shownKeys();
        if (keys.length === 0) return;

        // A window too narrow for the minimums has no answer that fits; the board
        // scrolls at that size rather than shrinking columns into nothing.
        const room = Math.max(
            Math.round(table.clientWidth - lockedWidth()),
            keys.length * MIN_COLUMN_WIDTH,
        );

        const weights = keys.map((key) => Math.max(MIN_COLUMN_WIDTH, stored[key] ?? MIN_COLUMN_WIDTH));
        const total = weights.reduce((sum, weight) => sum + weight, 0);
        const scale = room / total;

        let used = 0;
        const next = new Map<ColumnKey, number>();
        keys.forEach((key, index) => {
            const width = Math.max(MIN_COLUMN_WIDTH, Math.round(weights[index]! * scale));
            next.set(key, width);
            used += width;
        });

        // Rounding and the floor both leave a few pixels over. The widest column
        // takes them, where they cannot push anything under its minimum.
        const widest = keys.reduce((a, b) => (next.get(b)! > next.get(a)! ? b : a));
        next.set(widest, Math.max(MIN_COLUMN_WIDTH, next.get(widest)! + (room - used)));

        for (const key of keys) setWidth(key, next.get(key)!);
    }

    /** The column a handle trades with: the next one still on screen. */
    const partnerOf = (key: ColumnKey): ColumnKey | null => {
        const keys = shownKeys();
        const index = keys.indexOf(key);
        return index >= 0 && index < keys.length - 1 ? keys[index + 1]! : null;
    };

    /**
     * Every visible column, at the width it is actually wearing.
     *
     * All of them rather than the two that moved, because what is stored is a set
     * of weights the layout scales to fit: send only the pair and the set no
     * longer adds up to the room, so the next layout rescales all six and spreads
     * the drag across columns nobody touched. Sending the lot makes the round trip
     * a no-op, which is the only way the board can hold still.
     */
    const currentWidths = (): Partial<Record<ColumnKey, number>> =>
        Object.fromEntries(shownKeys().map((key) => [key, laid[key]]));

    /** Moves the boundary, conserving the pair's total between the two floors. */
    const moveBoundary = (
        key: ColumnKey,
        partner: ColumnKey,
        leftStart: number,
        rightStart: number,
        by: number,
    ) => {
        const applied = clamp(
            Math.round(by),
            MIN_COLUMN_WIDTH - leftStart,
            rightStart - MIN_COLUMN_WIDTH,
        );
        setWidth(key, leftStart + applied);
        setWidth(partner, rightStart - applied);
    };

    const startDrag = (key: ColumnKey, grip: HTMLElement, event: PointerEvent) => {
        const partner = partnerOf(key);
        if (!partner) return;

        event.preventDefault();
        const startX = event.clientX;
        const leftStart = laid[key];
        const rightStart = laid[partner];
        grip.setPointerCapture(event.pointerId);
        document.body.classList.add('is-resizing');

        const move = (moved: PointerEvent) =>
            moveBoundary(key, partner, leftStart, rightStart, moved.clientX - startX);

        const end = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', end);
            grip.removeEventListener('pointercancel', end);
            document.body.classList.remove('is-resizing');
            if (laid[key] === leftStart) return;

            const settled = currentWidths();
            stored = { ...stored, ...settled };
            onCommit(settled);
        };

        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', end);
        grip.addEventListener('pointercancel', end);
    };

    for (const key of HANDLE_KEYS) {
        const header = headerOf(key);
        if (!header) continue;

        const grip = h('span', {
            class: 'col-grip',
            role: 'separator',
            'aria-orientation': 'vertical',
            'aria-label': `Resize the ${header.textContent?.trim() || key} column`,
            tabindex: '0',
        });

        grip.addEventListener('pointerdown', (event) => startDrag(key, grip, event as PointerEvent));
        // A drag is not the only way to move a boundary; arrows do it in steps for
        // anyone not using a pointer.
        grip.addEventListener('keydown', (event) => {
            const step = event.key === 'ArrowLeft' ? -16 : event.key === 'ArrowRight' ? 16 : 0;
            const partner = step === 0 ? null : partnerOf(key);
            if (!partner) return;

            event.preventDefault();
            moveBoundary(key, partner, laid[key], laid[partner], step);

            const settled = currentWidths();
            stored = { ...stored, ...settled };
            onCommit(settled);
        });

        header.appendChild(grip);
    }

    return {
        apply(widths) {
            stored = { ...widths };
            layout();
        },
        relayout: layout,
    };
}
