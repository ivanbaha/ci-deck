import type { CredentialsInfo, ValueSource } from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { h, hostOf } from './dom.ts';
import { icon } from './icons.ts';
import { confirmDialog, openModal, type ModalHandle } from './modal.ts';
import { toastError, toastInfo } from './toast.ts';

const SOURCE_LABEL: Record<ValueSource, string> = {
    inline: 'set inline in the environment',
    file: 'set in the env file',
    store: 'saved on this machine',
    missing: 'not set',
};

const STORAGE_LABEL: Record<string, string> = {
    dpapi: 'Windows DPAPI',
    keychain: 'macOS Keychain',
    plaintext: 'plain text in the database',
};

/**
 * Where the URL and the token each came from, in words. The config window shows
 * this without opening the editor: "why can I not change this here" is answered
 * by the answer being on screen, not by the field being greyed out.
 */
export function describeCredentials(credentials: CredentialsInfo): string {
    const url = `URL ${SOURCE_LABEL[credentials.baseUrl.source]}`;
    const token = credentials.token.present
        ? `token ${SOURCE_LABEL[credentials.token.source]}`
            + (credentials.token.source === 'store'
                ? ` in ${STORAGE_LABEL[credentials.token.storage ?? ''] ?? credentials.token.storage}`
                : '')
        : 'no token';
    return `${url}, ${token}`;
}

let active: ModalHandle | null = null;

export function closeSetup(): void {
    active?.close();
    active = null;
}

function sourceNote(source: ValueSource, variable: string): HTMLElement | null {
    if (source !== 'inline' && source !== 'file') return null;
    return h('span', {
        class: 'hint',
        text: `Fixed by ${variable} — ${SOURCE_LABEL[source]}. Change it there, not here.`,
    });
}

/**
 * First-run and settings dialog. Credentials are verified against GitLab before
 * they are stored, so an accepted form means a working board.
 */
export function openSetup(credentials: CredentialsInfo, options: { dismissible: boolean }): void {
    closeSetup();

    const configured = credentials.complete && !credentials.authError;
    const modal = openModal({
        title: [configured ? 'GitLab connection' : 'Connect to GitLab'],
        small: true,
        dismissible: options.dismissible,
        onClose: () => {
            active = null;
        },
    });
    active = modal;

    const urlInput = h('input', {
        type: 'url',
        class: 'input',
        id: 'setup-url',
        placeholder: 'https://gitlab.com/',
        value: credentials.baseUrl.value ?? '',
        disabled: credentials.baseUrl.locked,
        autocomplete: 'off',
    });

    const tokenInput = h('input', {
        type: 'password',
        class: 'input',
        id: 'setup-token',
        placeholder: credentials.token.present ? credentials.token.masked ?? '••••••••' : 'glpat-…',
        disabled: credentials.token.locked,
        autocomplete: 'off',
    });

    const error = h('div', { class: 'form-error', role: 'alert' });
    if (credentials.authError) error.textContent = credentials.authError;
    else if (credentials.token.error) error.textContent = credentials.token.error;
    else if (credentials.baseUrl.error) error.textContent = credentials.baseUrl.error;

    /** What the last test said, in the same shape the add dialog's lookup uses. */
    const probe = h('div', { class: 'lookup', role: 'status' });

    /**
     * Shown only once the URL has actually been changed. A board pointed
     * somewhere else looks like a board that lost everything, and the one thing
     * worth knowing then is that it did not.
     */
    const current = credentials.baseUrl.value ?? '';
    const elsewhere = (typed: string) =>
        Boolean(current && typed)
        && typed.replace(/\/+$/, '').toLowerCase() !== current.replace(/\/+$/, '').toLowerCase();

    const switchNote = h('span', {
        class: 'form-warn',
        hidden: true,
        text: 'Another instance keeps its own watch list, tags included.'
            + ' The rows here are not deleted — they come back if you point the board at this URL again.',
    });

    const storageNote = credentials.token.locked
        ? 'The token comes from the environment and is not stored.'
        : `New tokens are kept in ${credentials.storageLabel}.${credentials.storageSecure ? '' : ' Anyone who can read your files can read it.'}`;

    modal.body.append(
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'setup-url', text: 'GitLab URL' }),
            urlInput,
            sourceNote(credentials.baseUrl.source, 'GITLAB_BASE_URL')
            ?? h('span', { class: 'hint', text: 'Instance root only, e.g. https://gitlab.com/' }),
            switchNote,
        ),
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'setup-token', text: 'Personal access token' }),
            tokenInput,
            sourceNote(credentials.token.source, 'GITLAB_PAT')
            ?? h('span', {
                class: 'hint',
                text: credentials.token.present
                    ? `Currently ${credentials.token.masked} (${STORAGE_LABEL[credentials.token.storage ?? ''] ?? credentials.token.storage}). Leave empty to keep it.`
                    : 'Needs the "api" scope, so jobs can be retried and cancelled.',
            }),
        ),
        h('p', { class: 'hint hint-block', text: storageNote }),
        probe,
        error,
    );

    const forget = button({
        label: 'Forget the stored token',
        text: 'Forget token',
        variant: 'danger',
        hidden: !credentials.token.present || credentials.token.locked,
    });
    const save = button({
        label: configured ? 'Save the connection' : 'Connect to GitLab',
        icon: 'cog',
        text: configured ? 'Save' : 'Connect',
        variant: 'confirm',
    });
    const test = button({
        label: 'Check the URL and token against the instance without saving them',
        icon: 'refresh',
        text: 'Test',
    });
    const cancel = button({ label: 'Close', text: 'Close', hidden: !options.dismissible });

    /** What the form is proposing, which is not always what is stored. */
    const proposed = () => ({
        baseUrl: credentials.baseUrl.locked ? undefined : urlInput.value.trim() || undefined,
        token: credentials.token.locked ? undefined : tokenInput.value.trim() || undefined,
    });

    const check = async () => {
        test.disabled = true;
        error.textContent = '';
        probe.replaceChildren(
            h('span', { class: 'spinner', 'aria-hidden': 'true' }),
            h('span', { class: 'hint', text: ' asking the instance…' }),
        );

        try {
            const result = await api.testCredentials(proposed());
            probe.replaceChildren(
                icon('status_success', 14),
                h('span', { class: 'lookup-path', text: `${result.username} on ${hostOf(result.baseUrl)}` }),
                h('span', { class: 'hint', text: 'nothing saved yet' }),
            );
        } catch (failure) {
            probe.replaceChildren(
                icon('status_failed', 14),
                h('span', {
                    class: 'lookup-miss',
                    text: failure instanceof Error ? failure.message : String(failure),
                }),
            );
        } finally {
            test.disabled = false;
        }
    };

    const submit = async () => {
        save.disabled = true;
        error.textContent = '';

        try {
            const result = await api.setCredentials(proposed());
            toastInfo(`Connected as ${result.username}`);
            if (result.warning) toastError(new Error(result.warning));
            modal.close();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            save.disabled = false;
        }
    };

    forget.addEventListener('click', async () => {
        const confirmed = await confirmDialog({
            title: 'Forget token',
            message: 'Remove the stored token from this machine? The watch list is kept.',
            confirmLabel: 'Forget',
            danger: true,
        });
        if (!confirmed) return;

        try {
            await api.forgetCredentials();
            toastInfo('Token removed');
            modal.close();
        } catch (failure) {
            toastError(failure);
        }
    });

    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', () => void submit());
    test.addEventListener('click', () => void check());
    for (const input of [urlInput, tokenInput]) {
        // A result about the last pair of values is worse than no result.
        input.addEventListener('input', () => probe.replaceChildren());
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') void submit();
        });
    }
    urlInput.addEventListener('input', () => {
        switchNote.hidden = !elsewhere(urlInput.value.trim());
    });

    modal.footer.append(forget, h('span', { class: 'spacer' }), cancel, test, save);
    (credentials.baseUrl.locked ? tokenInput : urlInput).focus();
}
