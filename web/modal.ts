import type { RepoCandidate, TagView } from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { byId, clear, h } from './dom.ts';
import { icon } from './icons.ts';

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
    className?: string;
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
            class: [
                'modal',
                options.small ? 'modal-sm' : '',
                options.tall ? 'modal-tall' : '',
                options.className ?? '',
            ].filter(Boolean).join(' '),
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

/** Long enough not to fire on every keystroke, short enough to feel immediate. */
const LOOKUP_DEBOUNCE_MS = 400;

/** A colon cannot appear in a git ref, so this can never be a branch name. */
const OTHER_BRANCH = '::other';

/**
 * Submit handler stays in charge of closing so API errors can be shown inline.
 *
 * The repo is looked up while it is being typed rather than when Add is pressed.
 * That is what turns "no GitLab project named that" from something you find out
 * after committing to it into something the dialog has already told you — and it
 * is the only way to offer the branches, which cannot be known before the project
 * behind the name is.
 */
export function addRepoDialog(
    defaultRef: string,
    knownTags: TagView[],
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
    const branchSelect = h('select', { class: 'input', id: 'add-repo-ref', disabled: true });
    const branchInput = h('input', {
        type: 'text',
        class: 'input',
        placeholder: defaultRef,
        autocomplete: 'off',
        hidden: true,
        'aria-label': 'Branch name',
    });
    const found = h('div', { class: 'lookup' });
    const error = h('div', { class: 'form-error', role: 'alert' });

    /**
     * Existing tags only: this dialog applies one, the tag manager makes them.
     * Every other tag a row carries is added afterwards, from its tag button.
     */
    const tagSelect = h(
        'select',
        { class: 'input', id: 'add-repo-tags', disabled: knownTags.length === 0 },
        h('option', { value: '', text: knownTags.length > 0 ? 'No tag' : 'No tags yet' }),
        ...knownTags.map((tag) => h('option', { value: tag.name, text: tag.name })),
    );

    const cancel = button({ label: 'Cancel', text: 'Cancel' });
    const add = button({
        label: 'Add the repo',
        icon: 'plus',
        text: 'Add',
        variant: 'confirm',
        disabled: true,
    });

    let candidate: RepoCandidate | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    /** Guards against a slow first lookup landing after a fast second one. */
    let generation = 0;

    const chosenRef = () =>
        branchSelect.value === OTHER_BRANCH ? branchInput.value.trim() : branchSelect.value;

    const chosenTags = () => (tagSelect.value ? [tagSelect.value] : []);

    const syncAdd = () => {
        const ref = chosenRef();
        add.disabled = candidate === null || !ref || (candidate.watchedRefs.includes(ref));
    };

    const drawBranches = (entry: RepoCandidate) => {
        clear(branchSelect);
        const branches = entry.branches.length > 0
            ? entry.branches
            : [entry.defaultBranch || defaultRef];

        for (const branch of branches) {
            const taken = entry.watchedRefs.includes(branch);
            branchSelect.appendChild(
                h('option', {
                    value: branch,
                    text: taken ? `${branch} — already watched` : branch,
                    disabled: taken,
                }),
            );
        }
        // A project with more branches than one page holds still has to be
        // reachable by name, or the dialog would simply refuse to watch them.
        if (entry.branchesTruncated) {
            branchSelect.appendChild(h('option', { value: OTHER_BRANCH, text: 'Another branch…' }));
        }

        const first = branches.find((branch) => !entry.watchedRefs.includes(branch));
        branchSelect.value = first ?? branches[0]!;
        branchSelect.disabled = false;
        branchInput.hidden = true;
        syncAdd();
    };

    const lookup = async (value: string) => {
        const mine = (generation += 1);
        candidate = null;
        branchSelect.disabled = true;
        clear(branchSelect);
        syncAdd();

        if (!value) {
            found.replaceChildren();
            return;
        }

        found.replaceChildren(
            h('span', { class: 'spinner', 'aria-hidden': 'true' }),
            h('span', { class: 'hint', text: ' looking it up…' }),
        );

        try {
            const result = await api.resolveRepo(value);
            if (mine !== generation) return;

            candidate = result.candidate;
            error.textContent = '';
            found.replaceChildren(
                icon('status_success', 14),
                h('span', { class: 'lookup-path', text: result.candidate.path }),
                ...(result.candidate.watchedRefs.length > 0
                    ? [h('span', {
                        class: 'hint',
                        text: `already watched on ${result.candidate.watchedRefs.join(', ')}`,
                    })]
                    : []),
            );
            drawBranches(result.candidate);
        } catch (failure) {
            if (mine !== generation) return;
            found.replaceChildren(
                icon('status_failed', 14),
                h('span', {
                    class: 'lookup-miss',
                    text: failure instanceof Error ? failure.message : String(failure),
                }),
            );
        }
    };

    repoInput.addEventListener('input', () => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void lookup(repoInput.value.trim()), LOOKUP_DEBOUNCE_MS);
    });

    branchSelect.addEventListener('change', () => {
        branchInput.hidden = branchSelect.value !== OTHER_BRANCH;
        if (!branchInput.hidden) branchInput.focus();
        syncAdd();
    });
    branchInput.addEventListener('input', syncAdd);

    modal.body.append(
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'add-repo-input', text: 'Repo name, path or GitLab URL' }),
            repoInput,
            found,
            h('span', {
                class: 'hint',
                text: 'A bare name is searched for on the instance; a full path or a pasted project URL is exact.',
            }),
        ),
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'add-repo-ref', text: 'Branch' }),
            branchSelect,
            branchInput,
            h('span', {
                class: 'hint',
                text: 'One row per branch — the same repo can be watched on several at once.',
            }),
        ),
        // Tagging on the way in beats coming back for it later.
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'add-repo-tags', text: 'Tags' }),
            tagSelect,
            h('span', {
                class: 'hint',
                text: knownTags.length > 0
                    ? 'Optional. More can be added later from the row.'
                    : 'No tags yet — create them in Configuration → Tags.',
            }),
        ),
        error,
    );

    const run = async () => {
        if (!candidate) {
            error.textContent = 'Enter a repo name or path first';
            repoInput.focus();
            return;
        }
        const ref = chosenRef();
        if (!ref) {
            error.textContent = 'Pick a branch to watch';
            return;
        }

        add.disabled = true;
        cancel.disabled = true;
        error.textContent = '';

        try {
            // The resolved path, not what was typed: an exact lookup on the way in
            // cannot land on a different project than the one just confirmed.
            await submit({ repo: candidate.path, ref, tags: chosenTags() });
            modal.close();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            add.disabled = false;
            cancel.disabled = false;
        }
    };

    cancel.addEventListener('click', () => modal.close());
    add.addEventListener('click', () => void run());
    repoInput.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        // Enter before the debounce has fired means "look it up now".
        if (timer) clearTimeout(timer);
        if (candidate) void run();
        else void lookup(repoInput.value.trim());
    });
    branchInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') void run();
    });

    modal.footer.append(h('span', { class: 'spacer' }), cancel, add);
    repoInput.focus();
}
