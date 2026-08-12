import type { TagView } from '../src/shared/types.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

/**
 * What a tag looks like, kept where everything that draws one can reach it.
 *
 * A row carries its tags as names — that is all the board needs to filter by —
 * so the colour has to come from somewhere else. Threading the tag list through
 * `renderRepo` would put it in the signature of every cell on the way past; a
 * register the board refreshes whenever the tags change costs one call in
 * `renderTagbar` and nothing anywhere else.
 */
const known = new Map<string, TagView>();

/** Called before rows are drawn, so a chip never paints a stale colour. */
export function setTagStyles(tags: TagView[]): void {
    known.clear();
    for (const tag of tags) known.set(tag.name, tag);
}

/** `name — what it is for`, for the tooltip behind a cluster of chips. */
export function tagLine(name: string): string {
    const description = known.get(name)?.description;
    return description ? `${name} — ${description}` : name;
}

export const INK_LIGHT = '#ffffff';

/** The near-black the dark theme is built on, rather than a flat #000. */
export const INK_DARK = '#1b1a1f';

/**
 * Where those two contrast equally, by WCAG's ratio. Not the 0.179 quoted for
 * black on white: the dark ink is not black, and its own luminance moves the
 * crossover up — at 0.179 a mid green would have been given the worse of the
 * two by a whisker.
 */
const INK_CROSSOVER = 0.202;

/**
 * Ink that can be read on a given colour, given only those two to choose from.
 * Both are fixed rather than tokens: this sits on the tag's own colour, which
 * is the same in either theme.
 *
 * It matters because the colour is the user's. A filled chip in pale yellow
 * with white text is a chip nobody can read, and no fixed choice survives a
 * palette that runs from #000 to #fff.
 */
export function readableInk(hex: string): string {
    const channel = (at: number) => {
        const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };

    const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    return luminance > INK_CROSSOVER ? INK_DARK : INK_LIGHT;
}

/**
 * The two properties every coloured chip is drawn from. Set together, because
 * the second is only ever a function of the first.
 *
 * Custom properties rather than a border and a background written out here: the
 * tints are `color-mix`ed from them in the stylesheet, so how a chip holds up in
 * light and dark stays the stylesheet's business.
 */
export function paint(element: HTMLElement, color: string): void {
    element.style.setProperty('--tag-color', color);
    element.style.setProperty('--tag-ink', readableInk(color));
}

/**
 * One chip, in a colour that may not be a tag's yet — the form previews the
 * colour being picked, which is nothing the register has heard of.
 */
export function colorChip(name: string, color: string | null): HTMLElement {
    const chip = h(
        'span',
        { class: `tag-chip${color ? ' tag-chip-colored' : ''}` },
        icon('tag', 10),
        h('span', { text: name }),
    );

    if (color) paint(chip, color);
    return chip;
}

/**
 * A row's chip: the same thing, in whatever colour the tag is registered in,
 * and carrying its own tip.
 *
 * The tip belongs on the chip rather than on the cluster around it. Hovering
 * one chip of four and being handed all four — the first of them at the top,
 * where it reads as the answer — says nothing about the one under the pointer.
 */
export function tagChip(name: string): HTMLElement {
    const tag = known.get(name);
    const chip = colorChip(name, tag?.color ?? null);

    if (tag?.description) {
        chip.setAttribute('data-tip-title', name);
        chip.setAttribute('data-tip', tag.description);
    } else {
        // No description to give, but a chip clipped by the cluster still has a
        // name worth reading whole.
        chip.setAttribute('data-tip', name);
    }
    return chip;
}

/** The colour on its own, for a list that names the tag beside it. */
export function colorDot(color: string | null): HTMLElement {
    const dot = h('span', { class: `tag-dot${color ? '' : ' tag-dot-empty'}`, 'aria-hidden': 'true' });
    if (color) dot.style.setProperty('--tag-color', color);
    return dot;
}
