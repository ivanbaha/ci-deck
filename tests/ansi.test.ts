import { describe, expect, it } from 'bun:test';
import { ansiToHtml, escapeHtml, tailLog } from '../web/ansi.ts';

const ESC = '\u001b';

describe('escapeHtml', () => {
    it('neutralises markup coming from job output', () => {
        expect(escapeHtml('<img src=x onerror="alert(1)">&')).toBe(
            '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;&amp;',
        );
    });
});

describe('ansiToHtml', () => {
    it('leaves plain text untouched', () => {
        expect(ansiToHtml('Running with gitlab-runner')).toBe('Running with gitlab-runner');
    });

    it('wraps coloured runs in classed spans', () => {
        expect(ansiToHtml(`${ESC}[32mpassed${ESC}[0m done`)).toBe('<span class="a-fg-32">passed</span> done');
    });

    it('combines bold with a colour', () => {
        expect(ansiToHtml(`${ESC}[1;31mERROR${ESC}[0m`)).toBe('<span class="a-b a-fg-31">ERROR</span>');
    });

    it('maps bright background codes down to the base range', () => {
        expect(ansiToHtml(`${ESC}[103mwarn${ESC}[0m`)).toBe('<span class="a-bg-43">warn</span>');
    });

    it('treats a bare reset sequence as a reset', () => {
        expect(ansiToHtml(`${ESC}[31mred${ESC}[mplain`)).toBe('<span class="a-fg-31">red</span>plain');
    });

    it('escapes html inside a coloured run', () => {
        expect(ansiToHtml(`${ESC}[31m<b>${ESC}[0m`)).toBe('<span class="a-fg-31">&lt;b&gt;</span>');
    });

    it('drops GitLab section markers and erase-line codes', () => {
        const raw = `section_start:1754560000:build_script\r${ESC}[0Kcompiling\nsection_end:1754560100:build_script\r${ESC}[0K`;
        expect(ansiToHtml(raw)).toBe('compiling\n');
    });

    it('keeps only the final state of a redrawn progress line', () => {
        expect(ansiToHtml('10%\r50%\r100%\ndone')).toBe('100%\ndone');
    });

    it('ignores cursor movement sequences', () => {
        expect(ansiToHtml(`${ESC}[2Aback${ESC}[K`)).toBe('back');
    });

    it('renders unmapped 256-colour codes as plain text', () => {
        expect(ansiToHtml(`${ESC}[38;5;208morange${ESC}[0m`)).toBe('orange');
    });

    it('drops every final byte but the colour one, including its neighbours', () => {
        expect(ansiToHtml(`a${ESC}[4@b${ESC}[4lc${ESC}[6nd${ESC}[2~e`)).toBe('abcde');
    });

    it('drops private-mode sequences and those with intermediate bytes whole', () => {
        expect(ansiToHtml(`${ESC}[?25l${ESC}[2 q${ESC}[!pready${ESC}[?25h`)).toBe('ready');
    });

    /** Final byte `m`, and still not a colour: this used to reach the page as `[>4;2m`. */
    it('drops a sequence that only ends like a colour', () => {
        expect(ansiToHtml(`${ESC}[>4;2mvim`)).toBe('vim');
    });

    it('drops colon-separated colour parameters rather than printing them', () => {
        expect(ansiToHtml(`${ESC}[4:3mcurly${ESC}[4:0m`)).toBe('curly');
    });

    it('keeps a colour running across a dropped sequence', () => {
        expect(ansiToHtml(`${ESC}[31mred ${ESC}[?25lstill${ESC}[0m`)).toBe('<span class="a-fg-31">red still</span>');
    });
});

describe('tailLog', () => {
    it('passes short logs through', () => {
        expect(tailLog('short', 100)).toEqual({ text: 'short', truncated: false });
    });

    it('keeps the tail and starts at a line boundary', () => {
        const raw = 'first line\nsecond line\nthird line\n';
        const result = tailLog(raw, 20);

        expect(result.truncated).toBe(true);
        expect(result.text.startsWith('first')).toBe(false);
        expect(raw.endsWith(result.text)).toBe(true);
        expect(result.text.startsWith('\n')).toBe(false);
    });
});
