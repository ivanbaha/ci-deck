import { h } from './dom.ts';
import { icon, type IconName } from './icons.ts';

export type ButtonVariant = 'default' | 'confirm' | 'danger' | 'inverted';

/** Tints the icon only, so a row of controls reads at a glance without shouting. */
export type ButtonTone = 'neutral' | 'info' | 'positive' | 'caution' | 'danger' | 'muted';

export interface ButtonOptions {
    /** Accessible name, also used as the tooltip. Required even with text. */
    label: string;
    icon?: IconName;
    /** Visible text; omit for an icon-only button. */
    text?: string;
    variant?: ButtonVariant;
    tone?: ButtonTone;
    small?: boolean;
    disabled?: boolean;
    hidden?: boolean;
    iconSize?: number;
    /** Data attributes, for click delegation on the board. */
    data?: Record<string, string>;
    onClick?: () => void;
}

const VARIANT_CLASS: Record<ButtonVariant, string> = {
    default: '',
    confirm: 'btn-confirm',
    danger: 'btn-danger',
    inverted: 'btn-inverted',
};

function classesFor(options: ButtonOptions): string {
    const iconOnly = options.text === undefined;
    return [
        'btn',
        VARIANT_CLASS[options.variant ?? 'default'],
        iconOnly ? 'btn-icon' : '',
        options.icon && !iconOnly ? 'btn-with-icon' : '',
        options.small ? 'btn-sm' : '',
        options.tone ? `tone-${options.tone}` : '',
    ]
        .filter(Boolean)
        .join(' ');
}

function fill(element: HTMLElement, options: ButtonOptions): void {
    if (options.icon) element.appendChild(icon(options.icon, options.iconSize ?? (options.small ? 16 : 19)));
    if (options.text !== undefined) element.appendChild(h('span', { text: options.text }));
}

/**
 * The one place buttons are built, so icon sizing, tooltips and the
 * icon-only accessible name stay consistent everywhere.
 */
export function button(options: ButtonOptions): HTMLButtonElement {
    const element = h('button', {
        type: 'button',
        class: classesFor(options),
        // The board's own tooltip rather than the browser's: it arrives without
        // the second of dead air, and a disabled control still gets one.
        'data-tip': options.label,
        'aria-label': options.label,
        disabled: options.disabled ?? false,
        hidden: options.hidden ?? false,
    });

    for (const [key, value] of Object.entries(options.data ?? {})) {
        element.setAttribute(`data-${key}`, value);
    }

    fill(element, options);
    if (options.onClick) element.addEventListener('click', options.onClick);

    return element;
}

