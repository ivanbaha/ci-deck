import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export interface MenuItem {
    label: string;
    icon?: IconName;
    onSelect: () => void;
}

interface ActiveMenu {
    element: HTMLElement;
    anchor: HTMLElement;
}

const GAP = 4;
const VIEWPORT_MARGIN = 8;

let active: ActiveMenu | null = null;

export function closeMenu(): void {
    if (!active) return;
    const { element, anchor } = active;
    active = null;

    element.remove();
    anchor.setAttribute('aria-expanded', 'false');
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('mousedown', onPointerDown, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
}

function onPointerDown(event: MouseEvent): void {
    const target = event.target as Node | null;
    if (!active || !target) return;
    // The anchor closes the menu itself, so ignoring it here avoids a reopen.
    if (active.element.contains(target) || active.anchor.contains(target)) return;
    closeMenu();
}

function itemsOf(menu: HTMLElement): HTMLButtonElement[] {
    return [...menu.querySelectorAll<HTMLButtonElement>('.menu-item')];
}

function onKeydown(event: KeyboardEvent): void {
    if (!active) return;

    if (event.key === 'Escape') {
        event.stopPropagation();
        const anchor = active.anchor;
        closeMenu();
        anchor.focus();
        return;
    }

    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;

    event.preventDefault();
    const buttons = itemsOf(active.element);
    if (buttons.length === 0) return;

    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const next = current === -1 ? 0 : (current + step + buttons.length) % buttons.length;
    buttons[next]!.focus();
}

/** Right-aligned with the anchor, flipping above when there is no room below. */
function position(element: HTMLElement, anchor: HTMLElement): void {
    const box = anchor.getBoundingClientRect();
    const size = element.getBoundingClientRect();

    const below = box.bottom + GAP;
    const top = below + size.height <= window.innerHeight - VIEWPORT_MARGIN
        ? below
        : Math.max(VIEWPORT_MARGIN, box.top - size.height - GAP);

    const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(box.right - size.width, window.innerWidth - size.width - VIEWPORT_MARGIN),
    );

    element.style.top = `${top}px`;
    element.style.left = `${left}px`;
}

/**
 * A dropdown for the secondary half of a split button. Deliberately small: it
 * closes on select, Escape, an outside click, a resize or any scroll, because a
 * menu that survives the page moving under it is worse than one that vanishes.
 */
export function openMenu(anchor: HTMLElement, items: MenuItem[]): void {
    const wasOpen = active?.anchor === anchor;
    closeMenu();
    if (wasOpen) return;

    const element = h(
        'div',
        { class: 'menu', role: 'menu' },
        ...items.map((item) =>
            h(
                'button',
                {
                    type: 'button',
                    class: 'menu-item',
                    role: 'menuitem',
                    onClick: () => {
                        closeMenu();
                        item.onSelect();
                    },
                },
                item.icon ? icon(item.icon, 16) : null,
                h('span', { text: item.label }),
            )
        ),
    );

    document.body.appendChild(element);
    anchor.setAttribute('aria-expanded', 'true');
    active = { element, anchor };

    position(element, anchor);
    itemsOf(element)[0]?.focus();

    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', closeMenu);
    window.addEventListener('scroll', closeMenu, true);
}
