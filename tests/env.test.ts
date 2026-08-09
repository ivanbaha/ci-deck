import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    applyEnvValues,
    EnvError,
    normaliseBaseUrl,
    parseEnvFile,
    readEnvFile,
    readOptionalDbPath,
    readOptionalPort,
    unexplainedByFiles,
    validateToken,
} from '../src/config/env.ts';

const TOUCHED = ['GITLAB_PAT', 'GITLAB_BASE_URL', 'CI_DECK_PORT', 'CI_DECK_DB', 'CI_DECK_SAMPLE'];
const original = new Map(TOUCHED.map((key) => [key, process.env[key]]));

afterEach(() => {
    for (const key of TOUCHED) {
        const value = original.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

function envFile(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'ci-deck-env-'));
    const path = join(dir, '.env');
    writeFileSync(path, content, 'utf-8');
    return path;
}

/** A dynamic key avoids TypeScript narrowing the variable to `undefined` after a delete. */
const readEnv = (key: string): string | undefined => process.env[key];

describe('parseEnvFile', () => {
    it('reads quoted, bare and exported values', () => {
        const values = parseEnvFile(
            ["GITLAB_PAT='glpat-single'", 'export OTHER="double"', 'BARE=plain', '', '# comment'].join('\n'),
        );

        expect(values).toEqual({ GITLAB_PAT: 'glpat-single', OTHER: 'double', BARE: 'plain' });
    });

    it('drops trailing comments from unquoted values but keeps them inside quotes', () => {
        const values = parseEnvFile(['A=value # trailing', "B='value # kept'"].join('\n'));

        expect(values.A).toBe('value');
        expect(values.B).toBe('value # kept');
    });

    it('ignores lines that are not assignments', () => {
        expect(parseEnvFile('just some text\n')).toEqual({});
    });
});

describe('readEnvFile', () => {
    it('reports a missing file without throwing', () => {
        const result = readEnvFile(join(tmpdir(), 'ci-deck-nope', '.env'));
        expect(result.loaded).toBe(false);
        expect(result.values).toEqual({});
    });

    it('returns the file contents without touching the process', () => {
        process.env.GITLAB_PAT = 'from-shell';
        const result = readEnvFile(envFile("GITLAB_PAT='from-file'"));

        expect(result.values.GITLAB_PAT).toBe('from-file');
        expect(process.env.GITLAB_PAT).toBe('from-shell');
    });
});

describe('applyEnvValues', () => {
    it('fills in a variable that is unset', () => {
        delete process.env.CI_DECK_SAMPLE;
        applyEnvValues({ CI_DECK_SAMPLE: 'filled' });
        expect(readEnv('CI_DECK_SAMPLE')).toBe('filled');
    });

    it('leaves an inline value alone', () => {
        process.env.CI_DECK_SAMPLE = 'from-shell';
        applyEnvValues({ CI_DECK_SAMPLE: 'from-file' });
        expect(process.env.CI_DECK_SAMPLE).toBe('from-shell');
    });

    it('treats an empty inline value as unset', () => {
        process.env.CI_DECK_SAMPLE = '';
        applyEnvValues({ CI_DECK_SAMPLE: 'filled' });
        expect(process.env.CI_DECK_SAMPLE).toBe('filled');
    });
});

describe('unexplainedByFiles', () => {
    it('attributes a value a file explains to that file, not to the shell', () => {
        // Bun applies ./.env before our code runs, so matching values are file values.
        const inline = unexplainedByFiles({ GITLAB_PAT: 'from-file' }, { GITLAB_PAT: 'from-file' });
        expect(inline.GITLAB_PAT).toBeUndefined();
    });

    it('keeps a value that differs from the file as inline', () => {
        const inline = unexplainedByFiles({ GITLAB_PAT: 'from-shell' }, { GITLAB_PAT: 'from-file' });
        expect(inline.GITLAB_PAT).toBe('from-shell');
    });

    it('keeps a value no file mentions', () => {
        const inline = unexplainedByFiles({ GITLAB_PAT: 'only-shell' }, {});
        expect(inline.GITLAB_PAT).toBe('only-shell');
    });

    it('ignores undefined entries', () => {
        expect(unexplainedByFiles({ NOTHING: undefined }, {})).toEqual({});
    });
});

describe('validateToken', () => {
    it('accepts and trims a plausible token', () => {
        expect(validateToken('  glpat-abc123  ')).toBe('glpat-abc123');
    });

    it('rejects an empty token', () => {
        expect(() => validateToken('   ')).toThrow(EnvError);
    });

    it('rejects characters a GitLab token never has', () => {
        expect(() => validateToken("glpat-'quoted value'")).toThrow(/stray quotes/);
    });
});

describe('normaliseBaseUrl', () => {
    it('adds the trailing slash the api client expects', () => {
        expect(normaliseBaseUrl('https://gitlab.example.com')).toBe('https://gitlab.example.com/');
    });

    it('keeps a hosted sub-path', () => {
        expect(normaliseBaseUrl('https://example.com/gitlab')).toBe('https://example.com/gitlab/');
    });

    it('rejects a value that is not a url', () => {
        expect(() => normaliseBaseUrl('gitlab.example.com')).toThrow(/Not a valid URL/);
    });

    it('rejects a non-http scheme', () => {
        expect(() => normaliseBaseUrl('ssh://gitlab.example.com')).toThrow(/must be http or https/);
    });

    it('rejects a pasted project page', () => {
        expect(() => normaliseBaseUrl('https://gitlab.example.com/group/repo/-/pipelines')).toThrow(
            /looks like a project page/,
        );
    });

    it('rejects a query string', () => {
        expect(() => normaliseBaseUrl('https://gitlab.example.com/?a=1')).toThrow(/query or fragment/);
    });

    it('rejects an empty value', () => {
        expect(() => normaliseBaseUrl('  ')).toThrow(EnvError);
    });
});

describe('optional env', () => {
    it('reads a port when set', () => {
        process.env.CI_DECK_PORT = '9001';
        expect(readOptionalPort()).toBe(9001);
    });

    it('returns null when the port is unset', () => {
        delete process.env.CI_DECK_PORT;
        expect(readOptionalPort()).toBeNull();
    });

    it('rejects a nonsense port', () => {
        process.env.CI_DECK_PORT = 'eight thousand';
        expect(() => readOptionalPort()).toThrow(EnvError);
    });

    it('reads a database override', () => {
        process.env.CI_DECK_DB = ' ./local.db ';
        expect(readOptionalDbPath()).toBe('./local.db');
    });
});
