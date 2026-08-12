import { describe, expect, it } from 'bun:test';
import { EXPORT_VERSION, parseExportFile, parseExportTags } from '../src/shared/watchlist.ts';
import { TEMPLATE } from '../web/import.ts';

/**
 * The template is what the import dialog hands anyone asking "what shape is
 * this file". It is written by hand beside the parser rather than produced by
 * it, so nothing but a test stops the two drifting — and a template teaching
 * last year's format is worse than no template at all.
 */
describe('the watch-list template', () => {
    it('declares the version the exporter writes', () => {
        expect(TEMPLATE.version).toBe(EXPORT_VERSION);
    });

    it('parses as the rows it means, through the real parser', () => {
        const rows = parseExportFile(TEMPLATE);

        expect(rows.map((row) => `${row.name}@${row.ref ?? ''}`)).toEqual([
            'my-service@',
            'other-service@main',
            'other-service@develop',
            'paused-service@',
        ]);
        expect(rows.find((row) => row.ref === 'develop')?.notify).toBe('snooze');
        expect(rows.find((row) => row.name === 'paused-service')?.watched).toBe(false);
    });

    /** Both shapes a tag may take in a file, so the template demonstrates both. */
    it('shows a bare tag and a described one, and both survive the parser', () => {
        expect(parseExportTags(TEMPLATE)).toEqual([
            { name: 'backs' },
            {
                name: 'release-blocking',
                description: 'A red row here stops the release',
                color: '#d1392b',
            },
        ]);
    });
});
