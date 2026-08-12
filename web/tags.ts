import type { RepoView, TagView } from '../src/shared/types.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';
import { confirmDialog, openModal } from './modal.ts';
import { colorChip, colorDot, paint } from './tag-style.ts';

/** A row's name, and its branch when that is not the only thing it says. */
export function repoLabel(repo: RepoView): string {
    return `${repo.name} · ${repo.ref}`;
}

/**
 * Ten colours a tag can be, spread around the wheel at one lightness so no two
 * are hard to tell apart and none of them disappears into either theme.
 */
const SWATCHES = [
    '#d1392b',
    '#c26a00',
    '#8f7300',
    '#2d8a4e',
    '#00857f',
    '#1f75cb',
    '#5b57c9',
    '#8b4bbd',
    '#bd4083',
    '#737278',
] as const;

const HEX = /^#[0-9a-f]{6}$/i;

/**
 * "Save this filter as a tag": a name to start the form with, and the rows the
 * board had narrowed itself to when it was asked.
 */
export interface TagSeed {
    name: string;
    repos: number[];
}

/**
 * The one form a tag is made and changed in.
 *
 * Opens over the configuration window rather than replacing it: the tag list
 * behind it is the thing being edited, and modals stack for exactly this.
 */
export function tagFormDialog(options: {
    /** The tag to edit, or null to make a new one. */
    tag: TagView | null;
    /** A name to start from, when something else already knows what to call it. */
    name?: string;
    /** What the caller is about to do with the tag, said before it is made. */
    hint?: string;
    onSaved(tags: TagView[]): void;
}): void {
    const editing = options.tag;
    const modal = openModal({
        title: [icon('tag', 16), editing ? `Edit ${editing.name}` : 'New tag'],
        small: true,
    });

    let color: string | null = editing ? editing.color : SWATCHES[5];

    const name = h('input', {
        type: 'text',
        class: 'input',
        id: 'tag-form-name',
        value: editing?.name ?? options.name ?? '',
        placeholder: 'release-blocking',
        autocomplete: 'off',
    });
    const description = h('input', {
        type: 'text',
        class: 'input',
        id: 'tag-form-description',
        value: editing?.description ?? '',
        placeholder: 'What the tag is for',
        autocomplete: 'off',
    });

    // Three ways at one value, because they answer different questions: the
    // swatches are "give me a sensible one", the well is "I know the one I
    // want", and the field is "paste the one from our palette".
    const hex = h('input', {
        type: 'text',
        class: 'input tag-hex',
        value: color ?? '',
        placeholder: '#1f75cb',
        maxLength: 7,
        spellcheck: false,
        autocomplete: 'off',
        'aria-label': 'Colour as a hex code',
    });
    const well = h('input', {
        type: 'color',
        class: 'tag-well',
        value: color ?? '#1f75cb',
        'aria-label': 'Pick a colour',
    });

    const preview = h('div', { class: 'tag-preview' });
    const swatches = h('div', { class: 'tag-swatches' });
    const error = h('div', { class: 'form-error', role: 'alert' });

    const drawPreview = () => {
        preview.replaceChildren(
            colorChip(name.value.trim() || 'tag', color),
            h('span', { class: 'hint', text: 'How the chip reads on a row' }),
        );
    };

    const drawSwatches = () => {
        swatches.replaceChildren(
            ...SWATCHES.map((value) => {
                const chosen = color?.toLowerCase() === value;
                const cell = h('button', {
                    type: 'button',
                    class: `swatch${chosen ? ' is-chosen' : ''}`,
                    'aria-pressed': String(chosen),
                    'data-tip': value,
                    'aria-label': `Colour ${value}`,
                    onClick: () => pick(value),
                });
                cell.style.setProperty('--tag-color', value);
                return cell;
            }),
            // A tag with no colour at all stays possible: that is what every tag
            // made before this form looked like, and some of them should stay so.
            h('button', {
                type: 'button',
                class: `swatch swatch-none${color ? '' : ' is-chosen'}`,
                'aria-pressed': String(color === null),
                'data-tip': 'No colour',
                'aria-label': 'No colour',
                onClick: () => pick(null),
            }, icon('close', 12)),
        );
    };

    const pick = (value: string | null) => {
        color = value;
        hex.value = value ?? '';
        if (value) well.value = value;
        drawSwatches();
        drawPreview();
    };

    hex.addEventListener('input', () => {
        const value = hex.value.trim();
        if (!value) pickQuietly(null);
        else if (HEX.test(value)) pickQuietly(value.toLowerCase());
    });
    well.addEventListener('input', () => pick(well.value));
    name.addEventListener('input', drawPreview);

    /** Typing is not a moment to move the field the typing is happening in. */
    const pickQuietly = (value: string | null) => {
        color = value;
        if (value) well.value = value;
        drawSwatches();
        drawPreview();
    };

    const cancel = button({ label: 'Cancel', text: 'Cancel' });
    const save = button({
        label: editing ? 'Save the tag' : 'Create the tag',
        text: editing ? 'Save' : 'Create',
        variant: 'confirm',
    });

    const run = async () => {
        const wanted = name.value.trim();
        if (!wanted) {
            error.textContent = 'A tag needs a name';
            name.focus();
            return;
        }
        if (hex.value.trim() && !HEX.test(hex.value.trim())) {
            error.textContent = 'A colour is six hex digits, like #1f75cb';
            hex.focus();
            return;
        }

        save.disabled = true;
        cancel.disabled = true;
        const fields = { name: wanted, description: description.value.trim() || null, color };

        try {
            const result = editing
                ? await api.updateTag(editing.name, fields)
                : await api.createTag(fields);
            options.onSaved(result.tags);
            modal.close();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            save.disabled = false;
            cancel.disabled = false;
        }
    };

    for (const field of [name, description, hex]) {
        field.addEventListener('keydown', (event) => {
            if (event.key === 'Enter') {
                event.preventDefault();
                void run();
            }
        });
    }
    cancel.addEventListener('click', () => modal.close());
    save.addEventListener('click', () => void run());

    drawSwatches();
    drawPreview();

    modal.body.append(
        // Spread rather than a null: `append` is the DOM's, and it would take a
        // null for the string "null" and render it.
        ...(options.hint ? [h('p', { class: 'form-note', text: options.hint })] : []),
        h('div', { class: 'form-row' }, h('label', { for: 'tag-form-name', text: 'Name' }), name),
        h(
            'div',
            { class: 'form-row' },
            h('label', { for: 'tag-form-description', text: 'Description' }),
            description,
            h('span', { class: 'hint', text: 'Optional. Shown when a row’s tags are hovered.' }),
        ),
        h(
            'div',
            { class: 'form-row' },
            h('label', { text: 'Colour' }),
            swatches,
            h('div', { class: 'tag-color-row' }, well, hex, preview),
        ),
        error,
    );
    modal.footer.append(h('span', { class: 'spacer' }), cancel, save);
    name.focus();
    name.select();
}

/**
 * The bulk path, and the one that matters at scale: pick a tag, tick its repos
 * from a searchable list. Eighty repos across seven tags is seven passes here,
 * against eighty dialogs the other way round.
 *
 * A pane rather than a dialog of its own — it is one half of the config window
 * now, which is where a thing you set up rather than a thing you do belongs.
 */
export function tagsPane(options: {
    repos(): RepoView[];
    tags(): TagView[];
    /** Pulls the board again, since a membership change moves many rows at once. */
    onChange(): void;
    /** A tag the board wants made, with the rows it should carry. */
    seed?: TagSeed;
}): HTMLElement {
    let tags = [...options.tags()];
    let selected = tags[0]?.name ?? null;
    let members = new Set<number>();
    let filter = '';

    /**
     * One membership write at a time. Every call sends the tag's whole list, so
     * two of them in flight would settle in whatever order they happened to
     * land — which, ticking down a column of boxes, is not the order they were
     * ticked in.
     */
    let queue: Promise<void> = Promise.resolve();

    const tagList = h('div', { class: 'tag-manage-list' });
    const memberPane = h('div', { class: 'tag-manage-members' });
    const error = h('div', { class: 'form-error', role: 'alert' });
    // Lives out here because a tick updates it without redrawing the list under
    // the pointer — forty boxes rebuilt on every click is forty chances to miss.
    const countLabel = () => `${members.size} selected`;
    const count = h('span', { class: 'muted', text: countLabel() });

    const membersOf = (tag: string) =>
        new Set(options.repos().filter((repo) => repo.tags.includes(tag)).map((repo) => repo.id));

    /**
     * `carrying` is for the case where the board cannot be asked yet: a write
     * that just landed is on its way back over the event stream, and reading the
     * rows now would show the membership as it was a moment ago.
     */
    const select = (tag: string | null, carrying?: Set<number>) => {
        selected = tag;
        members = tag ? (carrying ?? membersOf(tag)) : new Set();
        filter = '';
        count.textContent = countLabel();
        drawTags();
        drawMembers();
    };

    const refresh = () => {
        options.onChange();
        error.textContent = '';
    };

    function drawTags(): void {
        tagList.replaceChildren(
            ...tags.map((tag) =>
                h(
                    'div',
                    { class: `tag-manage-row${tag.name === selected ? ' is-selected' : ''}` },
                    h('button', {
                        type: 'button',
                        class: 'tag-manage-pick',
                        'data-tip-title': tag.name,
                        'data-tip': tag.description
                            ?? `${tag.count} row${tag.count === 1 ? '' : 's'} carry it`,
                        onClick: () => select(tag.name),
                    }, colorDot(tag.color), h('span', { class: 'tag-manage-name', text: tag.name }), h('span', { class: 'group-count', text: String(tag.count) })),
                    button({
                        label: `Edit ${tag.name}`,
                        icon: 'pencil',
                        small: true,
                        onClick: () => edit(tag),
                    }),
                    button({
                        label: `Delete ${tag.name}`,
                        icon: 'trash',
                        small: true,
                        tone: 'danger',
                        onClick: () => void remove(tag.name),
                    }),
                )
            ),
        );
        if (tags.length === 0) {
            tagList.appendChild(h('p', { class: 'hint', text: 'No tags yet. Add one with +.' }));
        }
    }

    function drawMembers(): void {
        if (!selected) {
            memberPane.replaceChildren(h('p', { class: 'hint', text: 'Pick a tag to choose which repos carry it.' }));
            return;
        }

        const repos = options.repos();
        const search = h('input', {
            type: 'search',
            class: 'input',
            placeholder: `Filter ${repos.length} rows`,
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
            filter === ''
            || repo.name.toLowerCase().includes(filter)
            || repo.group.toLowerCase().includes(filter)
            || repo.ref.toLowerCase().includes(filter)
        );

        const list = h(
            'div',
            { class: 'tag-member-list' },
            ...matching.map((repo) => {
                const box = h('input', { type: 'checkbox', checked: members.has(repo.id) });
                box.addEventListener('change', () => toggle(repo.id, box.checked, box));
                return h(
                    'label',
                    { class: 'tag-member' },
                    box,
                    h('span', { class: 'tag-member-name', text: repo.name }),
                    h('span', { class: 'repo-ref', text: repo.ref }),
                    h('span', { class: 'muted', text: repo.group }),
                );
            }),
        );
        if (matching.length === 0) list.appendChild(h('p', { class: 'hint', text: 'Nothing matches.' }));

        memberPane.replaceChildren(
            h(
                'div',
                { class: 'tag-member-head' },
                search,
                h('span', { class: 'spacer' }),
                count,
                h('span', { class: 'hint', text: 'Saved as you tick.' }),
            ),
            list,
        );
    }

    /**
     * A tick is the save. There was an Apply button here, which meant a pane you
     * could close having changed nothing you thought you had changed — and the
     * board updates itself off the write, so there is nothing to wait for.
     */
    function toggle(repoId: number, on: boolean, box: HTMLInputElement): void {
        const tag = selected;
        if (!tag) return;

        if (on) members.add(repoId);
        else members.delete(repoId);
        count.textContent = countLabel();

        const wanted = [...members];
        queue = queue.then(async () => {
            try {
                tags = (await api.setTagRepos(tag, wanted)).tags;
                error.textContent = '';
                drawTags();
            } catch (failure) {
                error.textContent = failure instanceof Error ? failure.message : String(failure);
                // Put it back: the row does not carry the tag, whatever the box says.
                if (on) members.delete(repoId);
                else members.add(repoId);
                if (tag === selected) {
                    box.checked = !on;
                    count.textContent = countLabel();
                }
            }
        });
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
            refresh();
            drawTags();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
        }
    }

    /**
     * Both directions of the form: `tag` is null when making a new one, and a
     * `seed` is the board asking for one — a name to start from and the rows the
     * filter behind it had matched, which become the new tag's membership.
     */
    function edit(tag: TagView | null, seed?: TagSeed): void {
        tagFormDialog({
            tag,
            name: seed?.name,
            hint: seed
                ? `${seed.repos.length} row${seed.repos.length === 1 ? '' : 's'} match the filter on the board. They will carry this tag.`
                : undefined,
            onSaved: (next) => {
                const before = tags.map((entry) => entry.name);
                tags = next;
                // A rename moves the selection with it, and a new tag takes it:
                // whichever name is in the list that was not there before.
                const added = next.find((entry) => !before.includes(entry.name));
                if (added && seed) void carry(added.name, seed.repos);
                else if (added && (tag === null || tag.name === selected)) select(added.name);
                else if (tag && tag.name === selected) select(selected);
                else drawTags();
                refresh();
            },
        });
    }

    /** The membership a seeded tag was made for, applied the moment it exists. */
    async function carry(tag: string, repos: number[]): Promise<void> {
        select(tag, new Set(repos));
        try {
            tags = (await api.setTagRepos(tag, repos)).tags;
            error.textContent = '';
            drawTags();
        } catch (failure) {
            error.textContent = failure instanceof Error ? failure.message : String(failure);
            select(tag);
        }
    }

    const add = button({
        label: 'Create a tag',
        icon: 'plus',
        small: true,
        onClick: () => edit(null),
    });

    select(selected);
    // The board asked for a tag on the way in, so the form is already open.
    if (options.seed) edit(null, options.seed);

    return h(
        'div',
        { class: 'tag-pane' },
        h(
            'div',
            { class: 'tag-manage' },
            h(
                'div',
                { class: 'tag-manage-side' },
                h(
                    'div',
                    { class: 'tag-manage-head' },
                    h('h3', { class: 'popover-title', text: 'Tags' }),
                    h('span', { class: 'spacer' }),
                    add,
                ),
                tagList,
            ),
            h('div', { class: 'tag-manage-main' }, memberPane),
        ),
        error,
    );
}

/**
 * Big chips on one line where they fit, small ones over two where they do not.
 *
 * Measured rather than guessed: a chip is as wide as its name, and how many
 * names fit depends on the window, the group select beside it and how much the
 * search field was given. Two passes at most — full size, and if that wrapped,
 * compact — because the compact pass can only ever fit more.
 *
 * A width of zero is a bar that has not been laid out yet, which a background
 * tab can stay in for as long as it likes. Measuring that would compact a bar
 * that has all the room in the world, so it waits for the observer instead.
 */
function fitTagBar(container: HTMLElement): void {
    const width = container.clientWidth;
    if (width === 0) return;

    fittedAt = width;
    container.classList.remove('is-compact');
    if (lineCount(container) > 1) container.classList.add('is-compact');
}

/** How many rows the chips have wrapped onto, by where their tops sit. */
function lineCount(container: HTMLElement): number {
    const tops = new Set<number>();
    for (const child of container.children) tops.add((child as HTMLElement).offsetTop);
    return tops.size;
}

/** The width the chips were last fitted to, so the observer can ignore the rest. */
let fittedAt = -1;
let observer: ResizeObserver | null = null;

/**
 * The bar is not resized only by the window: the search field, the group select
 * and the sweep box all take from the same line, and a tab that was never shown
 * gets its first real width the moment it is. Watching the element catches all
 * of it, where a window listener catches one.
 *
 * Only a change of width re-fits — compacting changes the bar's height, and
 * reacting to that would be a loop.
 */
function watchTagBar(container: HTMLElement): void {
    if (observer) return;

    observer = new ResizeObserver(() => {
        if (container.clientWidth !== fittedAt) fitTagBar(container);
    });
    observer.observe(container);
}

/**
 * The chips in the toolbar: the board's tag filter.
 *
 * Filtering only. It narrows what is on screen and nothing else — the sweep still
 * covers every watched repo, so a tag you have not selected is still a tag that
 * can tell you its pipeline broke.
 *
 * No management here. Making, editing and deleting tags is Configuration → Tags,
 * so this bar is only ever the tags themselves.
 */
export function renderTagBar(options: {
    container: HTMLElement;
    tags: TagView[];
    active: string[];
    onToggle(tag: string): void;
    onClear(): void;
    onSaveFilter(): void;
    saveable: boolean;
}): void {
    const { container, tags, active } = options;
    container.replaceChildren();

    // Ahead of the chips: it appears and disappears with the filter behind it,
    // and at the end it would shunt the whole row sideways every time it did.
    // Only when the search or the group has narrowed the board to something a
    // tag could stand for — otherwise there is nothing to save.
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
        ...tags.map((tag) => {
            const on = active.includes(tag.name);
            const chip = h(
                'button',
                {
                    type: 'button',
                    class: [
                        'tag-chip',
                        'tag-chip-filter',
                        on ? 'is-active' : '',
                        tag.color ? 'tag-chip-colored' : '',
                    ].filter(Boolean).join(' '),
                    'aria-pressed': String(on),
                    'data-tip-title': tag.description ?? null,
                    'data-tip': `${tag.count} row${tag.count === 1 ? '' : 's'} — click to ${
                        on ? 'stop filtering by this' : 'filter by this'
                    }`,
                    onClick: () => options.onToggle(tag.name),
                },
                icon('tag', 12),
                h('span', { text: tag.name }),
                h('span', { class: 'tag-chip-count', text: String(tag.count) }),
            );

            if (tag.color) paint(chip, tag.color);
            return chip;
        }),
    );

    // After them, where the chips it clears have just been read.
    if (active.length > 0) {
        container.append(
            button({
                label: 'Clear the tag filter',
                icon: 'close',
                text: 'Clear',
                small: true,
                onClick: options.onClear,
            }),
        );
    }

    fitTagBar(container);
    watchTagBar(container);
}
