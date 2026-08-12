import type { AppMeta } from '../src/shared/types.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { openSetup } from './setup.ts';

export interface ConnectionButton {
    element: HTMLButtonElement;
    update(meta: AppMeta): void;
}

const STATE_CLASSES = ['conn-ok', 'conn-warn', 'conn-bad', 'conn-none'];

function hostOf(baseUrl: string | null): string {
    if (!baseUrl) return '';
    try {
        return new URL(baseUrl).host;
    } catch {
        return baseUrl;
    }
}

/**
 * The connection is one thing, so it gets one control: who you are connected as,
 * and the way to change it. It also carries the state — a rejected token used to
 * show up only in a banner you scroll past, while the button next to it sat there
 * looking perfectly content.
 *
 * The repo count deliberately is not here. That is board state, and the All tab
 * already counts them.
 */
export function connectionButton(getMeta: () => AppMeta | null): ConnectionButton {
    const label = h('span', { class: 'conn-label' });
    const element = h(
        'button',
        { type: 'button', class: 'btn btn-conn' },
        icon('gitlab', 18),
        label,
    );

    element.addEventListener('click', () => {
        const meta = getMeta();
        if (meta) openSetup(meta.credentials, { dismissible: true });
    });

    const update = (meta: AppMeta) => {
        const { credentials } = meta;
        const host = hostOf(meta.gitlabBaseUrl);

        const [state, text, title] = !credentials.complete
            ? ['conn-none', 'Connect to GitLab', 'No GitLab connection yet — click to set one up'] as const
            : meta.authError
                ? ['conn-bad', host || 'GitLab', `GitLab rejected the token — ${meta.authError}`] as const
                : credentials.reachError
                    ? ['conn-warn', host || 'GitLab', `${host} is not reachable — ${credentials.reachError}`] as const
                    : ['conn-ok', [meta.user, host].filter(Boolean).join(' · '), `Connected to ${host}${meta.user ? ` as ${meta.user}` : ''}`] as const;

        element.classList.remove(...STATE_CLASSES);
        element.classList.add(state);
        label.textContent = text;
        element.setAttribute('data-tip', title);
        element.setAttribute('aria-label', title);
    };

    return { element, update };
}
