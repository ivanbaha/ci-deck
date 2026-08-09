type Child = Node | string | number | null | undefined | false;

type Props = Record<string, unknown>;

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
        else (node as unknown as Record<string, unknown>)[key] = value;
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

/** Hours and minutes only: seconds are noise on a row that says "3m ago" above. */
export function formatClock(iso: string | null): string {
    if (!iso) return '';
    const time = Date.parse(iso);
    return Number.isNaN(time)
        ? ''
        : new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
