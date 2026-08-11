import type { TagView } from '../src/shared/types.ts';
import { button } from './button.ts';
import { byId, clear, h } from './dom.ts';
import { tagPicker } from './tags.ts';

export interface ModalHandle {
    close(): void;
    /** Body element, so callers can stream content in after opening. */
    body: HTMLElement;
    footer: HTMLElement;
    setTitle(nodes: (Node | string)[]): void;
}

export interface ModalOptions {
    title: (Node | string)[];
    /** Full-bleed dark body, used by the log viewer. */
    flush?: boolean;
    /** Fills the viewport height so a long body scrolls inside the modal. */
    tall?: boolean;
    small?: boolean;
    /** False for a blocking dialog: no close button, Escape and backdrop ignored. */
    dismissible?: boolean;
    onClose?: () => void;
}

/**
 * Open modals, innermost last.
 *
 * A stack rather than one slot: a confirmation raised from inside a dialog used
 * to close the dialog that asked for it, which left the answer being written
 * back into a detached tree — deleting a tag from the tag manager took the
 * manager with it.
 */
const stack: ModalHandle[] = [];

/** What a modal is allowed to move focus between while it is on top. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function openModal(options: ModalOptions): ModalHandle {
    const previousFocus = document.activeElement as HTMLElement | null;
    const titleNode = h('h2', { class: 'modal-title' });
    const body = h('div', { class: `modal-body${options.flush ? ' modal-body-flush' : ''}` });
    const footer = h('div', { class: 'modal-foot' });

    const dismissible = options.dismissible !== false;
    const closeButton = button({ label: 'Close', icon: 'close', hidden: !dismissible });

    const modal = h(
        'div',
        {
            class: `modal${options.small ? ' modal-sm' : ''}${options.tall ? ' modal-tall' : ''}`,
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': 'dialog',
        },
        h('div', { class: 'modal-head' }, titleNode, h('span', { class: 'topbar-spacer' }), closeButton),
        body,
        footer,
    );

    const overlay = h('div', { class: 'overlay' }, modal);

    const close = () => {
        if (!stack.includes(handle)) return;
        // Anything opened on top of this belongs to it, so it goes first — closing
        // the one underneath must not leave a dialog floating over nothing.
        while (stack[stack.length - 1] !== handle) stack[stack.length - 1]!.close();

        stack.pop();
        document.removeEventListener('keydown', onKeydown);
        overlay.remove();
        options.onClose?.();
        previousFocus?.focus?.();
    };

    /** Tab must not walk out of a dialog and into the board behind it. */
    const trapFocus = (event: KeyboardEvent) => {
        const focusable = [...modal.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
            (node) => !node.hasAttribute('hidden'),
        );
        if (focusable.length === 0) return;

        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const current = document.activeElement;

        if (!modal.contains(current)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
        } else if (event.shiftKey && current === first) {
            event.preventDefault();
            last.focus();
        } else if (!event.shiftKey && current === last) {
            event.preventDefault();
            first.focus();
        }
    };

    const onKeydown = (event: KeyboardEvent) => {
        // Only the innermost dialog answers, or one Escape would close them all.
        if (stack[stack.length - 1] !== handle) return;

        if (event.key === 'Escape' && dismissible) {
            event.stopPropagation();
            close();
        } else if (event.key === 'Tab') {
            trapFocus(event);
        }
    };

    const handle: ModalHandle = {
        close,
        body,
        footer,
        setTitle(nodes) {
            clear(titleNode);
            for (const node of nodes) {
                titleNode.appendChild(node instanceof Node ? node : document.createTextNode(node));
            }
        },
    };

    handle.setTitle(options.title);
    closeButton.addEventListener('click', close);
    overlay.addEventListener('mousedown', (event) => {
        if (event.target === overlay && dismissible) close();
    });
    document.addEventListener('keydown', onKeydown);

    byId('modal-root').appendChild(overlay);
    stack.push(handle);
    closeButton.focus();
    return handle;
}

export function confirmDialog(options: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
}): Promise<boolean> {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        const modal = openModal({
            title: [options.title],
            small: true,
            onClose: () => finish(false),
        });

        modal.body.appendChild(h('p', { class: 'modal-message', text: options.message }));

        const cancel = button({ label: 'Cancel', text: 'Cancel', onClick: () => modal.close() });
        const confirm = button({
            label: options.confirmLabel,
            text: options.confirmLabel,
            variant: options.danger ? 'danger' : 'confirm',
            onClick: () => {
                finish(true);
                modal.close();
            },
        });

        modal.footer.append(h('span', { class: 'spacer' }), cancel, confirm);
        confirm.focus();
    });
}

export interface AddRepoResult {
    repo: string;
    ref: string;
    tags: string[];
}

/** Submit handler stays in charge of closing so API errors can be shown inline. */
export function addRepoDialog(
    defaultRef: string,
    /** Null hides the tag field entirely, for builds where tags are switched off. */
    knownTags: TagView[] | null,
    submit: (result: AddRepoResult) => Promise<void>,
): void {
    const modal = openModal({ title: ['Add repo to watch'], small: true });

    const repoInput = h('input', {
        type: 'text',
        class: 'input',
        id: 'add-repo-input',
        placeholder: 'group/team/my-service',
        autocomplete: 'off',
    });
    const refInput = h('input', {
        type: 'text',
        class: 'input',
        id: 'add-repo-ref',
        placeholder: defaultRef,
        autocomplete: 'off',
    });
    const picker = knownTags ? tagPicker(knownTags, []) : null;
    const error = h('div', { class: 'form-error', role: 'alert' });

    modal.body.append(
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'add-repo-input', text: 'Repo name, path or GitLab URL' }),
            repoInput,
            h('span', {
                class: 'hint',
                text: 'A bare name is searched for on the instance; a full path or a pasted project URL is exact.',
            }),
        ),
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'add-repo-ref', text: 'Branch' }),
            refInput,
            h('span', { class: 'hint', text: `Leave empty to use "${defaultRef}".` }),
        ),
        error,
    );

    // Tagging on the way in beats coming back for it later — when tags are on.
    if (picker) {
        error.before(
            h(
                'div',
                { class: 'form-row' },
                h('label', { text: 'Tags' }),
                picker.element,
                h('span', { class: 'hint', text: 'Optional. Comma or Enter to add; a new name creates the tag.' }),
            ),
        );
    }

    const cancel = button({ label: 'Cancel', text: 'Cancel' });
    const add = button({ label: 'Add the repo', icon: 'plus', text: 'Add', variant: 'confirm' });

    const run = async () => {
        const repo = repoInput.value.trim();
        if (!repo) {
            error.textContent = 'Enter a repo name or path';
            repoInput.focus();
            return;
        }

        add.disabled = true;
        cancel.disabled = true;
        error.textContent = '';

        try {
            await submit({ repo, ref: refInput.value.trim(), tags: picker?.value() ?? [] });
            modal.close();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            add.disabled = false;
            cancel.disabled = false;
        }
    };

    cancel.addEventListener('click', () => modal.close());
    add.addEventListener('click', () => void run());
    for (const input of [repoInput, refInput]) {
        input.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') void run();
        });
    }

    modal.footer.append(h('span', { class: 'spacer' }), cancel, add);
    repoInput.focus();
}
