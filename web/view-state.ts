/**
 * What the board is showing, kept in the address bar.
 *
 * These four are view, not configuration: they change several times a minute,
 * they belong to the window rather than to the install, and putting them in the
 * URL means a reload keeps them, the back button undoes them, and a filtered
 * board is something you can send to someone. That is a state manager already,
 * and it is one nobody has to maintain.
 *
 * The tag filter used to live in the database, where the sweep read it. It does
 * not need to any more: the sweep covers every watched repo regardless of what is
 * on screen, so the filter is nobody's business but this window's.
 */
export interface ViewState {
    tab: string;
    group: string;
    search: string;
    tags: string[];
}

export const DEFAULT_VIEW: ViewState = { tab: 'all', group: 'all', search: '', tags: [] };

/** Left out when it is the default, so a plain board has a plain URL. */
function toParams(view: ViewState): URLSearchParams {
    const params = new URLSearchParams();
    if (view.tab !== DEFAULT_VIEW.tab) params.set('tab', view.tab);
    if (view.group !== DEFAULT_VIEW.group) params.set('group', view.group);
    if (view.search) params.set('q', view.search);
    if (view.tags.length > 0) params.set('tags', view.tags.join(','));
    return params;
}

export function readView(search = window.location.search): ViewState {
    const params = new URLSearchParams(search);
    const tags = (params.get('tags') ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);

    return {
        tab: params.get('tab')?.trim() || DEFAULT_VIEW.tab,
        group: params.get('group')?.trim() || DEFAULT_VIEW.group,
        search: params.get('q')?.trim() ?? DEFAULT_VIEW.search,
        tags: [...new Set(tags)],
    };
}

/**
 * Replaces rather than pushes. Typing into the search box would otherwise leave
 * one history entry per keystroke, and Back would walk them one letter at a time.
 */
export function writeView(view: ViewState): void {
    const query = toParams(view).toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ''}`;
    if (next !== `${window.location.pathname}${window.location.search}`) {
        window.history.replaceState(null, '', next);
    }
}

export function onViewChange(handler: (view: ViewState) => void): void {
    window.addEventListener('popstate', () => handler(readView()));
}
