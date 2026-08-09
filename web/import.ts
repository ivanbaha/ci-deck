import type { RepoView } from '../src/shared/types.ts';
import { parseExportFile } from '../src/shared/watchlist.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { openModal } from './modal.ts';
import { toastInfo } from './toast.ts';

/** Mirrors what `GET /api/export` writes, minus the ids a fresh list cannot know. */
const TEMPLATE = {
    version: 1,
    settings: { pollPeriodSeconds: 120, defaultRef: 'main' },
    repos: [
        'my-service',
        { name: 'other-service', path: 'group/team/other-service', ref: 'develop' },
        { name: 'paused-service', path: 'group/team/paused-service', watched: false },
    ],
};

interface Parsed {
    payload: unknown;
    names: string[];
    fresh: string[];
    known: string[];
}

/**
 * Reads a list with the parser the server will run on it, so the preview cannot
 * drift from the result. The board already knows what is watched, so working out
 * what is new needs no extra endpoint.
 */
function parse(text: string, watched: RepoView[]): Parsed {
    const payload = JSON.parse(text) as unknown;
    const names = parseExportFile(payload).map((entry) => entry.name);
    const onBoard = new Set(watched.map((repo) => repo.name));

    return {
        payload,
        names,
        fresh: names.filter((name) => !onBoard.has(name)),
        known: names.filter((name) => onBoard.has(name)),
    };
}

function downloadTemplate(): void {
    const blob = new Blob([`${JSON.stringify(TEMPLATE, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: 'ci-deck-watchlist-template.json' });

    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/**
 * Replaces the bare file input the toolbar used to trigger. That gave no idea what
 * the file should contain, no idea what was about to happen, and reported failures
 * as three toasts with the rest dropped — useless for a list of eighty repos.
 */
export function openImportDialog(watched: RepoView[], onImported: () => void): void {
    const modal = openModal({ title: ['Import a watch list'], small: true });

    const fileInput = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    const browse = button({ label: 'Choose a file', icon: 'upload', text: 'Browse…' });
    const start = button({ label: 'Import the list', icon: 'import', text: 'Import', variant: 'confirm', disabled: true });
    const cancel = button({ label: 'Cancel', text: 'Cancel' });

    const drop = h(
        'div',
        { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Drop a watch list file here, or browse' },
        icon('upload', 28),
        h('span', { class: 'dropzone-main', text: 'Drop a watch list here' }),
        h('span', { class: 'hint', text: 'a JSON file exported from CI Deck, or written by hand' }),
    );

    const summary = h('div', { class: 'import-summary' });
    const error = h('div', { class: 'form-error', role: 'alert' });

    let parsed: Parsed | null = null;

    const showSummary = (nodes: (Node | string)[]) => {
        summary.replaceChildren(...nodes.map((n) => (n instanceof Node ? n : document.createTextNode(n))));
    };

    const accept = async (file: File) => {
        error.textContent = '';
        parsed = null;
        start.disabled = true;

        try {
            parsed = parse(await file.text(), watched);
        } catch (failure) {
            showSummary([]);
            error.textContent = failure instanceof SyntaxError
                ? `${file.name} is not valid JSON — ${failure.message}`
                : failure instanceof Error ? failure.message : String(failure);
            return;
        }

        if (parsed.names.length === 0) {
            showSummary([]);
            error.textContent = `${file.name} has no repos in it. Download the template to see the shape.`;
            return;
        }

        const { fresh, known } = parsed;
        showSummary([
            h('div', { class: 'import-file' }, icon('import', 16), h('span', { text: file.name })),
            h('div', {}, h('strong', { text: `${fresh.length}` }), ` repo${fresh.length === 1 ? '' : 's'} to add`),
            known.length > 0
                ? h('div', { class: 'hint', text: `${known.length} already on the board, left alone` })
                : null,
            h('div', { class: 'hint import-names', text: fresh.slice(0, 8).join(', ') + (fresh.length > 8 ? `, and ${fresh.length - 8} more` : '') }),
        ].filter(Boolean) as Node[]);

        start.disabled = fresh.length === 0;
    };

    const run = async () => {
        if (!parsed) return;
        start.disabled = true;
        cancel.disabled = true;

        try {
            const { added, skipped } = await api.importList(parsed.payload);
            toastInfo(`Imported ${added.length} repo${added.length === 1 ? '' : 's'}`);
            onImported();

            if (skipped.length === 0) {
                modal.close();
                return;
            }

            // Every skip, in the dialog: a long list of toasts helps nobody.
            showSummary([
                h('div', {}, h('strong', { text: `${added.length}` }), ' added'),
                h('div', { class: 'import-skipped-head', text: `${skipped.length} skipped:` }),
                h(
                    'ul',
                    { class: 'import-skipped' },
                    ...skipped.map((entry) => h('li', {}, h('code', { text: entry.repo }), ` — ${entry.reason}`)),
                ),
            ]);
            cancel.disabled = false;
            cancel.textContent = 'Close';
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            start.disabled = false;
            cancel.disabled = false;
        }
    };

    const pick = () => fileInput.click();

    drop.addEventListener('click', pick);
    drop.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            pick();
        }
    });
    for (const type of ['dragenter', 'dragover'] as const) {
        drop.addEventListener(type, (event) => {
            event.preventDefault();
            drop.classList.add('dropzone-over');
        });
    }
    for (const type of ['dragleave', 'dragend'] as const) {
        drop.addEventListener(type, () => drop.classList.remove('dropzone-over'));
    }
    drop.addEventListener('drop', (event) => {
        event.preventDefault();
        drop.classList.remove('dropzone-over');
        const file = event.dataTransfer?.files?.[0];
        if (file) void accept(file);
    });

    fileInput.addEventListener('change', () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (file) void accept(file);
    });

    browse.addEventListener('click', pick);
    cancel.addEventListener('click', () => modal.close());
    start.addEventListener('click', () => void run());

    const template = button({ label: 'Download a template file', text: 'Download a template' });
    template.addEventListener('click', downloadTemplate);

    modal.body.append(drop, fileInput, summary, error);
    modal.footer.append(template, h('span', { class: 'spacer' }), browse, cancel, start);
    drop.focus();
}

export { parse as parseImportPreview };
