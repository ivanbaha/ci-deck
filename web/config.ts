import type { AppState, NotifyMode, Settings, ThemePreference } from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { openModal, type ModalHandle } from './modal.ts';
import { permission, requestPermission } from './notify.ts';
import { describeCredentials, openSetup } from './setup.ts';
import { tagsPane } from './tags.ts';
import { applyTheme } from './theme.ts';
import { toastError, toastInfo } from './toast.ts';

/** Fixed choices beat a free-form number: every option is a sensible poll rate. */
export const INTERVALS: { seconds: number; label: string }[] = [
    { seconds: 30, label: '30s' },
    { seconds: 60, label: '60s' },
    { seconds: 120, label: '2m' },
    { seconds: 300, label: '5m' },
    { seconds: 600, label: '10m' },
    { seconds: 900, label: '15m' },
];

const NOTIFY_LABELS: { value: NotifyMode; label: string }[] = [
    { value: 'on', label: 'On — notify and chime' },
    { value: 'snooze', label: 'Snoozed — notify silently' },
    { value: 'off', label: 'Off — say nothing' },
];

const THEME_LABELS: { value: ThemePreference; label: string }[] = [
    { value: 'system', label: 'Follow the system' },
    { value: 'dark', label: 'Dark' },
    { value: 'light', label: 'Light' },
];

export type ConfigPane = 'general' | 'tags';

export interface ConfigOptions {
    state(): AppState | null;
    /** Applies a settings change and keeps the board in step with it. */
    save(patch: Parameters<typeof api.setSettings>[0]): Promise<void>;
    /** Pulls the board again, since a tag change moves many rows at once. */
    reload(): void;
}

let active: ModalHandle | null = null;
let redraw: (() => void) | null = null;

/**
 * Pulls an open config window back into step with the board.
 *
 * The sweep interval is deliberately in both places, so the two have to agree:
 * changing it on the board while this is open would otherwise leave the dropdown
 * here showing the old value until it was reopened.
 *
 * Not while a control here has focus, though — every change in this window comes
 * back as one of these, and rebuilding the dropdown someone just used takes the
 * focus out from under them.
 */
export function refreshConfig(): void {
    if (document.activeElement?.closest('.config-pane')) return;
    redraw?.();
}

function labelled(label: string, control: Node, hint?: string): HTMLElement {
    return h(
        'div',
        { class: 'form-row' },
        h('label', { text: label }),
        control,
        hint ? h('span', { class: 'hint', text: hint }) : null,
    );
}

function select<T extends string>(
    options: { value: T; label: string }[],
    value: T,
    onChange: (value: T) => void,
): HTMLSelectElement {
    const element = h(
        'select',
        { class: 'input' },
        ...options.map((option) => h('option', { value: option.value, text: option.label })),
    );
    element.value = value;
    element.addEventListener('change', () => onChange(element.value as T));
    return element;
}

/** A checkbox and its wording on one line, which is how a switch reads. */
function toggle(label: string, checked: boolean, onChange: (on: boolean) => void): HTMLElement {
    const box = h('input', { type: 'checkbox', checked });
    box.addEventListener('change', () => onChange(box.checked));
    return h('label', { class: 'config-toggle' }, box, h('span', { text: label }));
}

/**
 * The connection, said rather than edited. The editor behind it is the same
 * dialog the header button opens — this is the one place that says where the
 * credentials came from, which is the part nobody could see before.
 */
function connectionBlock(state: AppState): HTMLElement {
    const { meta } = state;
    const { credentials } = meta;

    const [tone, headline] = !credentials.complete
        ? ['conn-none', 'Not connected yet'] as const
        : meta.authError
            ? ['conn-bad', 'GitLab rejected the token'] as const
            : credentials.reachError
                ? ['conn-warn', `${meta.gitlabBaseUrl} is not reachable`] as const
                : ['conn-ok', `${meta.user ?? 'connected'} · ${meta.gitlabBaseUrl}`] as const;

    return h(
        'div',
        { class: `config-conn ${tone}` },
        icon('gitlab', 20),
        h(
            'div',
            { class: 'config-conn-text' },
            h('span', { class: 'config-conn-head', text: headline }),
            h('span', { class: 'hint', text: describeCredentials(credentials) }),
            meta.authError || credentials.reachError
                ? h('span', { class: 'form-error', text: meta.authError ?? credentials.reachError ?? '' })
                : null,
        ),
        button({
            label: 'Open the GitLab connection settings',
            text: credentials.complete ? 'Change…' : 'Connect…',
            onClick: () => openSetup(credentials, { dismissible: true }),
        }),
    );
}

function generalPane(options: ConfigOptions, state: AppState, redraw: () => void): HTMLElement {
    const settings: Settings = state.settings;

    const apply = (patch: Parameters<typeof api.setSettings>[0]) => {
        options.save(patch).catch(toastError);
    };

    const intervals = INTERVALS.some((entry) => entry.seconds === settings.pollPeriodSeconds)
        ? INTERVALS
        : [...INTERVALS, { seconds: settings.pollPeriodSeconds, label: `${settings.pollPeriodSeconds}s` }]
            .sort((a, b) => a.seconds - b.seconds);

    const period = select(
        intervals.map((entry) => ({ value: String(entry.seconds), label: entry.label })),
        String(settings.pollPeriodSeconds),
        (value) => apply({ pollPeriodSeconds: Number.parseInt(value, 10) }),
    );

    const notifications = select(NOTIFY_LABELS, settings.notifications, (value) => {
        apply({ notifications: value });
        // The permission prompt has to ride a gesture, and this is one.
        if (value !== 'off') void ensurePermission(redraw);
    });

    const state$ = permission();
    const permissionNote = state$ === 'granted'
        ? 'This browser is allowed to show notifications.'
        : state$ === 'denied'
            ? 'This browser is blocking notifications — the board falls back to an on-screen message. Allow them in the site settings to get desktop ones.'
            : state$ === 'unsupported'
                ? 'This browser has no notification support; the board falls back to an on-screen message.'
                : 'This browser has not been asked yet.';

    return h(
        'div',
        { class: 'config-pane' },
        h('h3', { class: 'config-heading', text: 'GitLab' }),
        connectionBlock(state),

        h('h3', { class: 'config-heading', text: 'Sweeping' }),
        labelled(
            'Check every',
            period,
            'The same control as the one on the board; either changes the other.',
        ),
        labelled(
            'Default branch',
            (() => {
                const input = h('input', {
                    type: 'text',
                    class: 'input',
                    value: settings.defaultRef,
                    autocomplete: 'off',
                });
                const commit = () => {
                    const next = input.value.trim();
                    if (next && next !== settings.defaultRef) apply({ defaultRef: next });
                };
                input.addEventListener('change', commit);
                input.addEventListener('keydown', (event) => {
                    if (event.key === 'Enter') commit();
                });
                return input;
            })(),
            'What a repo added without a branch watches, and the branch rows are not checked for deletion against.',
        ),

        h('h3', { class: 'config-heading', text: 'Running jobs' }),
        toggle(
            'Ask before starting a manual job',
            settings.confirmManualRun,
            (on) => apply({ confirmManualRun: on }),
        ),
        h('span', {
            class: 'hint',
            text: 'Manual jobs commonly deploy to a real environment, so this is on by default.',
        }),

        h('h3', { class: 'config-heading', text: 'Notifications' }),
        labelled(
            'When a pipeline finishes',
            notifications,
            'Applies over every row: a row set to notify still goes quiet while this is snoozed, and silent while it is off.',
        ),
        h(
            'div',
            { class: 'config-row' },
            h('span', { class: 'hint', text: permissionNote }),
            state$ === 'default'
                ? button({
                    label: 'Allow notifications in this browser',
                    text: 'Allow…',
                    small: true,
                    onClick: () => void ensurePermission(redraw),
                })
                : null,
        ),
        h('span', {
            class: 'hint',
            text: 'Notifications need a board tab open — there is no background worker — and the sound only starts after you have clicked the page once.',
        }),

        h('h3', { class: 'config-heading', text: 'Appearance' }),
        labelled(
            'Theme',
            select(THEME_LABELS, settings.theme, (value) => {
                // Applied before the round trip: a theme that lags a network call
                // feels broken even when it is only a hundred milliseconds.
                applyTheme(value);
                apply({ theme: value });
            }),
        ),
        h('span', {
            class: 'hint',
            text: 'Column widths are dragged from the board header and saved here too.',
        }),
    );
}

async function ensurePermission(redraw: () => void): Promise<void> {
    const result = await requestPermission();
    if (result === 'denied') toastInfo('This browser is blocking notifications for the board');
    redraw();
}

/** One window for everything that is set up rather than done. */
export function openConfig(options: ConfigOptions, pane: ConfigPane = 'general'): void {
    active?.close();

    const state = options.state();
    if (!state) return;

    let current = pane;
    const body = h('div', { class: 'config-body' });
    const nav = h('div', { class: 'config-nav' });

    const modal = openModal({
        title: [icon('cog', 18), 'Configuration'],
        className: 'modal-config',
        onClose: () => {
            active = null;
            redraw = null;
        },
    });
    active = modal;

    const draw = () => {
        const latest = options.state();
        if (!latest) return;

        nav.replaceChildren(
            ...(['general', 'tags'] as ConfigPane[]).map((key) =>
                h('button', {
                    type: 'button',
                    class: `config-tab${current === key ? ' is-active' : ''}`,
                    'aria-selected': String(current === key),
                    text: key === 'general' ? 'General' : 'Tags',
                    onClick: () => {
                        current = key;
                        draw();
                    },
                })
            ),
        );

        body.replaceChildren(
            current === 'general'
                ? generalPane(options, latest, draw)
                : tagsPane({
                    repos: () => options.state()?.repos ?? [],
                    tags: () => options.state()?.tags ?? [],
                    onChange: options.reload,
                }),
        );
    };

    // Only the General pane reads settings that change elsewhere; redrawing the
    // tag manager under someone mid-edit would lose the ticks they had made.
    redraw = () => {
        if (current === 'general') draw();
    };
    draw();

    const close = button({ label: 'Close', text: 'Close' });
    close.addEventListener('click', () => modal.close());

    modal.body.append(h('div', { class: 'config' }, nav, body));
    modal.footer.append(
        h('span', { class: 'hint', text: `Stored in ${state.meta.storePath}` }),
        h('span', { class: 'spacer' }),
        close,
    );
}
