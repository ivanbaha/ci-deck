import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { DEFAULT_PORT, HOSTNAME, parseArgs } from '../src/config/args.ts';

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
    });

    it('binds to loopback only', () => {
        expect(HOSTNAME).toBe('127.0.0.1');
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
});
