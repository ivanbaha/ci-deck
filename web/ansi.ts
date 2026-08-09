const SECTION_MARKER = /section_(?:start|end):\d+:[^\r\n]*/g;
const ERASE_IN_LINE = /\u001b\[\d*K/g;
const SGR = /\u001b\[([0-9;]*)m/g;
/** Any CSI sequence except SGR (`m`), which carries the colours we keep. */
const OTHER_CSI = /\u001b\[[0-9;?]*[@-ln-~]/g;

interface SgrState {
    fg: number | null;
    bg: number | null;
    bold: boolean;
    underline: boolean;
}

function emptyState(): SgrState {
    return { fg: null, bg: null, bold: false, underline: false };
}

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * Runner logs redraw progress with carriage returns; only the final state of a
 * line is meaningful, which is what GitLab shows too.
 */
function collapseCarriageReturns(text: string): string {
    return text
        .split('\n')
        .map((line) => {
            if (!line.includes('\r')) return line;
            const segments = line.split('\r').filter((segment) => segment !== '');
            return segments.length === 0 ? '' : segments[segments.length - 1]!;
        })
        .join('\n');
}

function prepare(raw: string): string {
    return collapseCarriageReturns(
        raw.replace(/\r\n/g, '\n').replace(SECTION_MARKER, '').replace(ERASE_IN_LINE, ''),
    );
}

function applyCodes(state: SgrState, params: string): void {
    const codes = params === '' ? [0] : params.split(';').map((part) => Number.parseInt(part, 10) || 0);

    for (let i = 0; i < codes.length; i += 1) {
        const code = codes[i]!;

        if (code === 0) {
            Object.assign(state, emptyState());
        } else if (code === 1) state.bold = true;
        else if (code === 22) state.bold = false;
        else if (code === 4) state.underline = true;
        else if (code === 24) state.underline = false;
        else if (code === 39) state.fg = null;
        else if (code === 49) state.bg = null;
        else if (code >= 30 && code <= 37) state.fg = code;
        else if (code >= 90 && code <= 97) state.fg = code;
        else if (code >= 40 && code <= 47) state.bg = code;
        else if (code >= 100 && code <= 107) state.bg = code - 60;
        else if (code === 38 || code === 48) {
            // Extended colours are not mapped; skip their parameters.
            const mode = codes[i + 1];
            i += mode === 5 ? 2 : mode === 2 ? 4 : 1;
            if (code === 38) state.fg = null;
            else state.bg = null;
        }
    }
}

function classesFor(state: SgrState): string {
    const classes: string[] = [];
    if (state.bold) classes.push('a-b');
    if (state.underline) classes.push('a-u');
    if (state.fg !== null) classes.push(`a-fg-${state.fg}`);
    if (state.bg !== null) classes.push(`a-bg-${state.bg}`);
    return classes.join(' ');
}

function wrap(chunk: string, state: SgrState): string {
    if (chunk === '') return '';
    const escaped = escapeHtml(chunk);
    const classes = classesFor(state);
    return classes ? `<span class="${classes}">${escaped}</span>` : escaped;
}

/** Renders a GitLab job trace as HTML, keeping SGR colours and dropping control noise. */
export function ansiToHtml(raw: string): string {
    const text = prepare(raw).replace(OTHER_CSI, '');
    const state = emptyState();
    let out = '';
    let cursor = 0;
    let match: RegExpExecArray | null;

    SGR.lastIndex = 0;
    while ((match = SGR.exec(text)) !== null) {
        out += wrap(text.slice(cursor, match.index), state);
        applyCodes(state, match[1] ?? '');
        cursor = SGR.lastIndex;
    }

    return out + wrap(text.slice(cursor), state);
}

export const LOG_TAIL_LIMIT = 500_000;

/** Keeps the tail of very long traces so the modal stays responsive. */
export function tailLog(raw: string, limit = LOG_TAIL_LIMIT): { text: string; truncated: boolean } {
    if (raw.length <= limit) return { text: raw, truncated: false };
    const sliced = raw.slice(raw.length - limit);
    const firstBreak = sliced.indexOf('\n');
    return { text: firstBreak === -1 ? sliced : sliced.slice(firstBreak + 1), truncated: true };
}
