import type { RepoView, TagView } from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { confirmDialog, openModal } from './modal.ts';
import { toastInfo } from './toast.ts';

/**
 * A chip input over the known tags. Deliberately not a combo box: typing a name
 * that does not exist yet creates it, because the alternative is a two-step
 * "create the tag, then come back and apply it" every time.
 */
export function tagPicker(known: TagView[], initial: string[]): {
    element: HTMLElement;
    value(): string[];
} {
    const chosen = [...new Set(initial)];
    const chips = h('div', { class: 'tag-chips' });

    const input = h('input', {
        type: 'text',
        class: 'input tag-input',
        placeholder: chosen.length === 0 ? 'lib, backs, CRUDs…' : 'add another…',
        list: 'known-tags',
        autocomplete: 'off',
    });

    const options = h(
        'datalist',
        { id: 'known-tags' },
        ...known.map((tag) => h('option', { value: tag.name })),
    );

    const draw = () => {
        chips.replaceChildren(
            ...chosen.map((tag) =>
                h(
                    'span',
                    { class: 'tag-chip tag-chip-editable' },
                    h('span', { text: tag }),
                    button({
                        label: `Remove ${tag}`,
                        icon: 'close',
                        small: true,
                        iconSize: 11,
                        onClick: () => {
                            chosen.splice(chosen.indexOf(tag), 1);
                            draw();
                        },
                    }),
                )
            ),
        );
    };

    const commit = () => {
        // Commas split, so a whole set can be pasted in one go.
        for (const raw of input.value.split(',')) {
            const tag = raw.trim();
            if (tag && !chosen.includes(tag)) chosen.push(tag);
        }
        input.value = '';
        draw();
    };

    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault();
            commit();
        } else if (event.key === 'Backspace' && input.value === '' && chosen.length > 0) {
            chosen.pop();
            draw();
        }
    });
    input.addEventListener('blur', commit);
    input.addEventListener('change', commit);

    draw();

    return {
        element: h('div', { class: 'tag-picker' }, chips, input, options),
        value: () => {
            commit();
            return [...chosen];
        },
    };
}

/** The per-repo path: discoverable, for one-off changes. */
export function openRepoTags(repo: RepoView, known: TagView[], onDone: () => void): void {
    const modal = openModal({ title: [`Tags for ${repo.name}`], small: true });
    const picker = tagPicker(known, repo.tags);
    const error = h('div', { class: 'form-error', role: 'alert' });

    const save = button({ label: 'Save tags', text: 'Save', variant: 'confirm' });
    const cancel = button({ label: 'Cancel', text: 'Cancel' });

    save.addEventListener('click', async () => {
        save.disabled = true;
        try {
            await api.setRepoTags(repo.name, picker.value());
            onDone();
            modal.close();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            save.disabled = false;
        }
    });
    cancel.addEventListener('click', () => modal.close());

    modal.body.append(
        h('div', { class: 'form-row' }, h('label', { text: 'Tags' }), picker.element,
            h('span', { class: 'hint', text: 'Comma or Enter to add. A name that does not exist yet is created.' })),
        error,
    );
    modal.footer.append(h('span', { class: 'spacer' }), cancel, save);
}

/**
 * The bulk path, and the one that matters at scale: pick a tag, tick its repos
 * from a searchable list. Eighty repos across seven tags is seven passes here,
 * against eighty dialogs the other way round.
 */
export function openManageTags(repos: RepoView[], known: TagView[], onDone: () => void): void {
    // The default width; the two panes get their own height cap in CSS.
    const modal = openModal({ title: ['Manage tags'] });

    let tags = [...known];
    let selected = tags[0]?.name ?? null;
    let members = new Set<string>();
    let filter = '';

    const tagList = h('div', { class: 'tag-manage-list' });
    const memberPane = h('div', { class: 'tag-manage-members' });
    const error = h('div', { class: 'form-error', role: 'alert' });

    const membersOf = (tag: string) => new Set(repos.filter((repo) => repo.tags.includes(tag)).map((r) => r.name));

    const select = (tag: string | null) => {
        selected = tag;
        members = tag ? membersOf(tag) : new Set();
        filter = '';
        drawTags();
        drawMembers();
    };

    const refresh = async () => {
        onDone();
        error.textContent = '';
    };

    function drawTags(): void {
        tagList.replaceChildren(
            ...tags.map((tag) => {
                const row = h(
                    'div',
                    { class: `tag-manage-row${tag.name === selected ? ' is-selected' : ''}` },
                    h('button', {
                        type: 'button',
                        class: 'tag-manage-pick',
                        onClick: () => select(tag.name),
                    }, h('span', { class: 'tag-manage-name', text: tag.name }), h('span', { class: 'group-count', text: String(tag.count) })),
                    button({
                        label: `Rename ${tag.name}`,
                        icon: 'cog',
                        small: true,
                        onClick: () => void rename(tag.name),
                    }),
                    button({
                        label: `Delete ${tag.name}`,
                        icon: 'trash',
                        small: true,
                        tone: 'danger',
                        onClick: () => void remove(tag.name),
                    }),
                );
                return row;
            }),
        );
        if (tags.length === 0) {
            tagList.appendChild(h('p', { class: 'hint', text: 'No tags yet. Create one below.' }));
        }
    }

    function drawMembers(): void {
        if (!selected) {
            memberPane.replaceChildren(h('p', { class: 'hint', text: 'Pick a tag to choose which repos carry it.' }));
            return;
        }

        const search = h('input', {
            type: 'search',
            class: 'input',
            placeholder: `Filter ${repos.length} repos`,
            value: filter,
            'aria-label': 'Filter repos',
        });
        search.addEventListener('input', () => {
            filter = search.value.trim().toLowerCase();
            drawMembers();
            // Redrawing steals focus, so it has to be put back where it was.
            const next = memberPane.querySelector<HTMLInputElement>('input[type="search"]');
            next?.focus();
            next?.setSelectionRange(next.value.length, next.value.length);
        });

        const matching = repos.filter((repo) =>
            filter === '' || repo.name.toLowerCase().includes(filter) || repo.group.toLowerCase().includes(filter)
        );

        const list = h(
            'div',
            { class: 'tag-member-list' },
            ...matching.map((repo) => {
                const box = h('input', { type: 'checkbox', checked: members.has(repo.name) });
                box.addEventListener('change', () => {
                    if (box.checked) members.add(repo.name);
                    else members.delete(repo.name);
                    count.textContent = `${members.size} selected`;
                });
                return h(
                    'label',
                    { class: 'tag-member' },
                    box,
                    h('span', { class: 'tag-member-name', text: repo.name }),
                    h('span', { class: 'muted', text: repo.group }),
                );
            }),
        );
        if (matching.length === 0) list.appendChild(h('p', { class: 'hint', text: 'Nothing matches.' }));

        const count = h('span', { class: 'muted', text: `${members.size} selected` });

        const all = button({
            label: 'Select every repo shown',
            text: 'All shown',
            small: true,
            onClick: () => {
                for (const repo of matching) members.add(repo.name);
                drawMembers();
            },
        });
        const none = button({
            label: 'Clear the selection',
            text: 'None',
            small: true,
            onClick: () => {
                members.clear();
                drawMembers();
            },
        });
        const apply = button({
            label: `Save which repos carry ${selected}`,
            text: 'Apply',
            variant: 'confirm',
            small: true,
            onClick: () => void save(),
        });

        memberPane.replaceChildren(
            h('div', { class: 'tag-member-head' }, search, all, none, h('span', { class: 'spacer' }), count, apply),
            list,
        );
    }

    async function save(): Promise<void> {
        if (!selected) return;
        try {
            const result = await api.setTagRepos(selected, [...members]);
            tags = result.tags;
            toastInfo(`${selected}: ${result.repos.length} repo${result.repos.length === 1 ? '' : 's'}`);
            await refresh();
            drawTags();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
        }
    }

    async function rename(from: string): Promise<void> {
        const next = window.prompt(`Rename "${from}" to:`, from)?.trim();
        if (!next || next === from) return;
        try {
            tags = (await api.renameTag(from, next)).tags;
            if (selected === from) selected = next;
            await refresh();
            drawTags();
            drawMembers();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
        }
    }

    async function remove(name: string): Promise<void> {
        const confirmed = await confirmDialog({
            title: 'Delete tag',
            message: `Delete "${name}"? The repos stay on the board; only the tag goes.`,
            confirmLabel: 'Delete',
            danger: true,
        });
        if (!confirmed) return;

        try {
            tags = (await api.deleteTag(name)).tags;
            if (selected === name) select(tags[0]?.name ?? null);
            await refresh();
            drawTags();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
        }
    }

    const newTag = h('input', { type: 'text', class: 'input', placeholder: 'New tag name', 'aria-label': 'New tag name' });
    const create = button({
        label: 'Create the tag',
        icon: 'plus',
        text: 'Create',
        onClick: async () => {
            const name = newTag.value.trim();
            if (!name) return;
            try {
                tags = (await api.createTag(name)).tags;
                newTag.value = '';
                select(name);
                await refresh();
            } catch (failure) {
                error.textContent = failure instanceof Error ? failure.message : String(failure);
            }
        },
    });
    newTag.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            create.click();
        }
    });

    const close = button({ label: 'Close', text: 'Close' });
    close.addEventListener('click', () => modal.close());

    modal.body.append(
        h(
            'div',
            { class: 'tag-manage' },
            h(
                'div',
                { class: 'tag-manage-side' },
                h('h3', { class: 'popover-title', text: 'Tags' }),
                tagList,
                h('div', { class: 'tag-manage-new' }, newTag, create),
            ),
            h('div', { class: 'tag-manage-main' }, memberPane),
        ),
        error,
    );
    modal.footer.append(h('span', { class: 'spacer' }), close);

    select(selected);
}

/** The chips under the status tabs: the board's tag filter. */
export function renderTagBar(options: {
    container: HTMLElement;
    tags: TagView[];
    active: string[];
    scoped: boolean;
    /** "3 of 43" — what the sweep would cover if scoping is on. */
    scopeSummary: string;
    onToggle(tag: string): void;
    onClear(): void;
    onScope(scoped: boolean): void;
    onManage(): void;
    onSaveFilter(): void;
    saveable: boolean;
}): void {
    const { container, tags, active, scoped } = options;
    container.replaceChildren();

    if (tags.length === 0 && !options.saveable) {
        container.appendChild(
            button({
                label: 'Create and manage tags',
                icon: 'tag',
                text: 'Tags',
                small: true,
                onClick: options.onManage,
            }),
        );
        container.appendChild(h('span', { class: 'hint', text: 'Group repos across namespaces however you like.' }));
        return;
    }

    container.append(
        h('span', { class: 'tagbar-label' }, icon('tag', 13), h('span', { text: 'Tags' })),
        ...tags.map((tag) => {
            const on = active.includes(tag.name);
            const chip = h(
                'button',
                {
                    type: 'button',
                    class: `tag-chip tag-chip-filter${on ? ' is-active' : ''}`,
                    'aria-pressed': String(on),
                    title: `${tag.count} repo${tag.count === 1 ? '' : 's'}`,
                    onClick: () => options.onToggle(tag.name),
                },
                h('span', { text: tag.name }),
                h('span', { class: 'tag-chip-count', text: String(tag.count) }),
            );
            return chip;
        }),
    );

    if (active.length > 0) {
        container.append(
            button({ label: 'Clear the tag filter', text: 'Clear', small: true, onClick: options.onClear }),
            // Scoping turns the filter from a view into what actually gets polled.
            (() => {
                const box = h('input', { type: 'checkbox', id: 'scope-sweep', checked: scoped });
                box.addEventListener('change', () => options.onScope(box.checked));
                const label = h('label', {
                    class: 'field tagbar-scope',
                    for: 'scope-sweep',
                    title: 'Poll only the repos carrying a selected tag, instead of every watched repo. The rest keep their last known state.',
                });
                label.append(
                    box,
                    document.createTextNode(' Check only these '),
                    h('span', { class: 'muted', text: options.scopeSummary }),
                );
                return label;
            })(),
        );
    }

    if (options.saveable) {
        container.append(
            button({
                label: 'Save the current filter as a tag',
                icon: 'tag',
                text: 'Save as tag',
                small: true,
                onClick: options.onSaveFilter,
            }),
        );
    }

    container.append(
        h('span', { class: 'toolbar-spacer' }),
        button({ label: 'Create and manage tags', icon: 'cog', text: 'Manage', small: true, onClick: options.onManage }),
    );
}

