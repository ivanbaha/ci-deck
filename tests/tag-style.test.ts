import { describe, expect, it } from 'bun:test';
import { INK_DARK, INK_LIGHT, readableInk } from '../web/tag-style.ts';

/** WCAG 2.x: (lighter + 0.05) / (darker + 0.05), on relative luminance. */
function contrast(background: string, ink: string): number {
    const luminance = (hex: string) => {
        const channel = (at: number) => {
            const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255;
            return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    };

    const a = luminance(background);
    const b = luminance(ink);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The ten the tag form offers, which is what most tags will end up wearing. */
const PALETTE = [
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
];

describe('readableInk', () => {
    it('puts white on a dark colour and near-black on a light one', () => {
        expect(readableInk('#000000')).toBe(INK_LIGHT);
        expect(readableInk('#1f75cb')).toBe(INK_LIGHT);
        expect(readableInk('#ffffff')).toBe(INK_DARK);
        expect(readableInk('#ffff00')).toBe(INK_DARK);
        expect(readableInk('#ffd6e7')).toBe(INK_DARK);
    });

    /**
     * The whole point of choosing: whichever it picks must be the better of the
     * two, for any colour a user can type into the form.
     */
    it('never picks the worse of the two, across the wheel', () => {
        for (let hue = 0; hue < 360; hue += 5) {
            for (const light of [25, 45, 65, 85]) {
                const hex = hslHex(hue, 70, light);
                const chosen = readableInk(hex);
                const other = chosen === INK_LIGHT ? INK_DARK : INK_LIGHT;

                expect(contrast(hex, chosen)).toBeGreaterThanOrEqual(contrast(hex, other));
            }
        }
    });

    it('clears 4:1 on every colour the form offers', () => {
        for (const color of PALETTE) {
            expect(contrast(color, readableInk(color))).toBeGreaterThan(4);
        }
    });
});

/** Test-only: a spread of real colours to check against, without a dependency. */
function hslHex(hue: number, saturation: number, lightness: number): string {
    const s = saturation / 100;
    const l = lightness / 100;
    const chroma = (1 - Math.abs(2 * l - 1)) * s;
    const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
    const offset = l - chroma / 2;

    const [r, g, b] = hue < 60
        ? [chroma, second, 0]
        : hue < 120
            ? [second, chroma, 0]
            : hue < 180
                ? [0, chroma, second]
                : hue < 240
                    ? [0, second, chroma]
                    : hue < 300
                        ? [second, 0, chroma]
                        : [chroma, 0, second];

    const byte = (value: number) =>
        Math.round((value + offset) * 255).toString(16).padStart(2, '0');
    return `#${byte(r!)}${byte(g!)}${byte(b!)}`;
}
