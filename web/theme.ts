import type { ThemePreference } from '../src/shared/types.ts';

/**
 * The preference lives in the database with everything else, so a second browser
 * shows the same board. That answer arrives a moment after the page does, though,
 * and a board that paints dark and then turns white is worse than one that waits
 * — so the last applied value is mirrored into `localStorage` and read back
 * before the first frame.
 *
 * `system` is the default and is not an absence: it means follow the operating
 * system, which the stylesheet does on its own through `prefers-color-scheme`.
 */
const MIRROR_KEY = 'ci-deck:theme';

function isTheme(value: unknown): value is ThemePreference {
    return value === 'system' || value === 'dark' || value === 'light';
}

export function applyTheme(theme: ThemePreference): void {
    const root = document.documentElement;
    if (theme === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', theme);

    try {
        localStorage.setItem(MIRROR_KEY, theme);
    } catch {
        // Private mode, or storage the user has turned off. The board still works;
        // it just flashes once on load when the stored theme is not the system one.
    }
}

/** Applied before anything is fetched, so the first paint is the right colour. */
export function restoreTheme(): void {
    try {
        const stored = localStorage.getItem(MIRROR_KEY);
        if (isTheme(stored)) applyTheme(stored);
    } catch {
        // As above.
    }
}
