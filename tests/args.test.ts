import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { DEFAULT_BIND, DEFAULT_PORT, isLoopbackBind, originForBind, parseArgs } from '../src/config/args.ts';

const CWD = resolve('/work/ci-deck');
const parse = (argv: string[]) => parseArgs(argv, CWD);

describe('parseArgs defaults', () => {
    it('reads the env file next to the working directory', () => {
        const args = parse([]);

        expect(args.envPath).toBe(resolve(CWD, '.env'));
        expect(args.dbPath).toBeNull();
        expect(args.port).toBeNull();
        expect(args.rebuild).toBe(false);
        expect(args.help).toBe(false);
        expect(args.version).toBe(false);
        expect(args.bind).toBe(DEFAULT_BIND);
        expect(args.origins).toEqual([]);
    });

    it('binds to loopback until told otherwise', () => {
        expect(DEFAULT_BIND).toBe('127.0.0.1');
        expect(isLoopbackBind(DEFAULT_BIND)).toBe(true);
    });

    it('exposes the fallback port for the CLI to apply', () => {
        expect(DEFAULT_PORT).toBe(8787);
    });
});

describe('parseArgs options', () => {
    it('resolves a relative --env path', () => {
        expect(parse(['--env', 'secrets/.env']).envPath).toBe(resolve(CWD, 'secrets/.env'));
    });

    it('resolves a relative --db path and keeps an absolute one', () => {
        expect(parse(['--db', 'local.db']).dbPath).toBe(resolve(CWD, 'local.db'));
        expect(parse(['--db', resolve('/tmp/p.db')]).dbPath).toBe(resolve('/tmp/p.db'));
    });

    it('parses --port and --rebuild', () => {
        const args = parse(['--port', '9000', '--rebuild']);
        expect(args.port).toBe(9000);
        expect(args.rebuild).toBe(true);
    });

    it('rejects a port outside the valid range', () => {
        expect(() => parse(['--port', '70000'])).toThrow(/Invalid --port/);
    });

    it('rejects a flag used as a value', () => {
        expect(() => parse(['--env', '--port'])).toThrow(/requires a value/);
    });

    it('rejects unknown flags', () => {
        expect(() => parse(['--host', '0.0.0.0'])).toThrow(/Unknown option/);
    });

    it('has no subcommands, since import and export live in the UI', () => {
        expect(() => parse(['import', 'list.json'])).toThrow(/Unknown option/);
        expect(() => parse(['export', 'list.json'])).toThrow(/Unknown option/);
    });

    it('recognises both help spellings', () => {
        expect(parse(['-h']).help).toBe(true);
        expect(parse(['--help']).help).toBe(true);
    });

    it('recognises both version spellings', () => {
        expect(parse(['-v']).version).toBe(true);
        expect(parse(['--version']).version).toBe(true);
    });

    it('takes an address to bind to', () => {
        expect(parse(['--bind', '0.0.0.0']).bind).toBe('0.0.0.0');
    });

    it('collects and normalises every --origin', () => {
        const args = parse(['--origin', 'http://ci-deck.example:8787/', '--origin', 'https://deck.example']);
        expect(args.origins).toEqual(['http://ci-deck.example:8787', 'https://deck.example']);
    });

    it('rejects an --origin that is not one', () => {
        expect(() => parse(['--origin', 'ci-deck.example'])).toThrow(/Invalid --origin/);
        expect(() => parse(['--origin', 'ftp://deck.example'])).toThrow(/http or https/);
        expect(() => parse(['--origin', 'http://deck.example/board'])).toThrow(/scheme, host and port/);
    });
});

describe('bind addresses', () => {
    it('knows which addresses stay off the network', () => {
        // 127.0.0.2 is as much loopback as 127.0.0.1, and must not be warned about.
        for (const address of ['127.0.0.1', '127.0.0.2', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
            expect(isLoopbackBind(address)).toBe(true);
        }
        for (const address of ['0.0.0.0', '::', '192.168.1.5']) {
            expect(isLoopbackBind(address)).toBe(false);
        }
    });

    // A wildcard is not a name anything can be pointed at.
    it('has no origin to add for a wildcard', () => {
        for (const address of ['0.0.0.0', '::', '[::]']) {
            expect(originForBind(address, 8787)).toBeNull();
        }
    });

    it('turns an address into the origin it is reached by', () => {
        expect(originForBind('192.168.1.5', 8787)).toBe('http://192.168.1.5:8787');
        expect(originForBind('127.0.0.2', 8787)).toBe('http://127.0.0.2:8787');
        expect(originForBind('fe80::1', 8787)).toBe('http://[fe80::1]:8787');
        expect(originForBind('[fe80::1]', 8787)).toBe('http://[fe80::1]:8787');
    });

    // Repeating loopback costs a Set insert; leaving it out would cost a 403.
    it('repeats loopback rather than assuming the guard has it', () => {
        expect(originForBind('127.0.0.1', 8787)).toBe('http://127.0.0.1:8787');
        expect(originForBind('localhost', 8787)).toBe('http://localhost:8787');
        expect(originForBind('::1', 8787)).toBe('http://[::1]:8787');
    });
});
