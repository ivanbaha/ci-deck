import { byId, h } from './dom.ts';

const VISIBLE_MS = 6_000;

function show(message: string, variant: 'info' | 'error'): void {
    const toast = h('div', { class: `toast${variant === 'error' ? ' toast-error' : ''}`, text: message });
    byId('toasts').appendChild(toast);
    setTimeout(() => toast.remove(), VISIBLE_MS);
}

export function toastError(error: unknown): void {
    show(error instanceof Error ? error.message : String(error), 'error');
}

export function toastInfo(message: string): void {
    show(message, 'info');
}
