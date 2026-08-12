type Child = Node | string | number | null | undefined | false;

type Props = Record<string, unknown>;

/**
 * Sets a prop as a property where the DOM has one, and as an attribute where it
 * does not.
 *
 * Two ways the old blanket assignment went wrong, both silent. A name the element
 * has no property for — `tabindex`, `for` — became an expando that nothing reads,
 * so the pre was never focusable and no label was ever tied to its input. And a
 * property that is a getter only — `input.list` — throws in a module, which runs
 * in strict mode: that one took out the whole Add repo dialog, landing between
 * opening the modal and filling it and leaving an empty shell on screen.
 */
function assign(node: HTMLElement, key: string, value: unknown): void {
    if (key in node) {
        try {
            (node as unknown as Record<string, unknown>)[key] = value;
            return;
        } catch {
            // Getter-only. The attribute behind it is what was meant either way.
        }
    }
    node.setAttribute(key, String(value));
}

/** Tiny element factory — keeps rendering declarative without a framework. */
export function h<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Props = {},
    ...children: Child[]
): HTMLElementTagNameMap[K] {
    const node = document.createElement(tag);

    for (const [key, value] of Object.entries(props)) {
        if (value === null || value === undefined || value === false) continue;

        // Deliberately no `html` prop: everything here goes through `text` or a
        // child node, so no caller can hand this function a string to parse.
        if (key === 'class') node.className = String(value);
        else if (key === 'text') node.textContent = String(value);
        else if (key.startsWith('on') && typeof value === 'function') {
            node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
        } else if (key.includes('-')) node.setAttribute(key, String(value));
        else assign(node, key, value);
    }

    appendChildren(node, children);
    return node;
}

export function appendChildren(parent: Node, children: Child[]): void {
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        parent.appendChild(child instanceof Node ? child : document.createTextNode(String(child)));
    }
}

export function clear(node: Node): void {
    while (node.firstChild) node.removeChild(node.firstChild);
}

export function byId<T extends HTMLElement>(id: string): T {
    const node = document.getElementById(id);
    if (!node) throw new Error(`Missing element #${id}`);
    return node as T;
}

export function formatDuration(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return '';
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    if (minutes < 60) return `${minutes}m ${total % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function formatRelative(iso: string | null, now = Date.now()): string {
    if (!iso) return '';
    const then = Date.parse(iso);
    if (Number.isNaN(then)) return '';

    const seconds = Math.max(0, Math.round((now - then) / 1_000));
    if (seconds < 10) return 'just now';
    if (seconds < 60) return `${seconds}s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;

    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;

    const days = Math.floor(hours / 24);
    return days < 30 ? `${days}d ago` : new Date(then).toLocaleDateString();
}

/** The whole moment, in the reader's own locale — what "23m ago" is hiding. */
export function formatAbsolute(iso: string | null): string | null {
    if (!iso) return null;
    const time = Date.parse(iso);
    return Number.isNaN(time) ? null : new Date(time).toLocaleString();
}

/** Hours and minutes only: seconds are noise on a row that says "3m ago" above. */
export function formatClock(iso: string | null): string {
    if (!iso) return '';
    const time = Date.parse(iso);
    return Number.isNaN(time)
        ? ''
        : new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
