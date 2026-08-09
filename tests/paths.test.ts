import { describe, expect, it } from 'bun:test';
import { dataDir, defaultDbPath } from '../src/config/paths.ts';

describe('dataDir', () => {
    it('uses LOCALAPPDATA on Windows', () => {
        const dir = dataDir({ LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' } as NodeJS.ProcessEnv, 'win32');
        expect(dir).toBe('C:\\Users\\me\\AppData\\Local\\ci-deck');
    });

    it('falls back to the profile directory on Windows', () => {
        const dir = dataDir({ USERPROFILE: 'C:\\Users\\me' } as NodeJS.ProcessEnv, 'win32');
        expect(dir).toContain('AppData');
        expect(dir).toContain('ci-deck');
    });

    it('uses Application Support on macOS', () => {
        const dir = dataDir({ HOME: '/Users/me' } as NodeJS.ProcessEnv, 'darwin');
        expect(dir).toBe('/Users/me/Library/Application Support/ci-deck');
    });

    it('honours XDG_DATA_HOME on Linux', () => {
        const dir = dataDir({ HOME: '/home/me', XDG_DATA_HOME: '/home/me/.data' } as NodeJS.ProcessEnv, 'linux');
        expect(dir).toBe('/home/me/.data/ci-deck');
    });

    it('defaults to ~/.local/share on Linux', () => {
        const dir = dataDir({ HOME: '/home/me' } as NodeJS.ProcessEnv, 'linux');
        expect(dir).toBe('/home/me/.local/share/ci-deck');
    });
});

describe('defaultDbPath', () => {
    it('puts the database inside the data directory', () => {
        const path = defaultDbPath({ HOME: '/Users/me' } as NodeJS.ProcessEnv, 'darwin');
        expect(path).toBe('/Users/me/Library/Application Support/ci-deck/ci-deck.db');
    });
});
