import type { CredentialsInfo, ValueSource } from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { h } from './dom.ts';
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
    const cancel = button({ label: 'Close', text: 'Close', hidden: !options.dismissible });

    const submit = async () => {
        save.disabled = true;
        error.textContent = '';

        try {
            const result = await api.setCredentials({
                baseUrl: credentials.baseUrl.locked ? undefined : urlInput.value.trim() || undefined,
                token: credentials.token.locked ? undefined : tokenInput.value.trim() || undefined,
            });
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
    for (const input of [urlInput, tokenInput]) {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') void submit();
        });
    }

    modal.footer.append(forget, h('span', { class: 'spacer' }), cancel, save);
    (credentials.baseUrl.locked ? tokenInput : urlInput).focus();
}
