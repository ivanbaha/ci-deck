import { describe, expect, it } from 'bun:test';
import { allowedOrigins, checkRequestOrigin } from '../src/server/guard.ts';

const SELF = 'http://127.0.0.1:8787';
const LOOPBACK = allowedOrigins(8787);

const request = (method: string, headers: Record<string, string> = {}) =>
    new Request(`${SELF}/api/repos/alpha/pipeline/retry`, { method, headers });

describe('checkRequestOrigin', () => {
    it('allows reads regardless of provenance', () => {
        expect(checkRequestOrigin(request('GET', { origin: 'https://evil.example' }), LOOPBACK).ok).toBe(true);
    });

    it('allows a write from our own page', () => {
        const result = checkRequestOrigin(
            request('POST', { origin: SELF, 'sec-fetch-site': 'same-origin' }),
            LOOPBACK,
        );
        expect(result.ok).toBe(true);
    });

    it('allows a header-less client such as curl', () => {
        expect(checkRequestOrigin(request('POST'), LOOPBACK).ok).toBe(true);
    });

    it('allows a direct address-bar navigation', () => {
        expect(checkRequestOrigin(request('POST', { 'sec-fetch-site': 'none' }), LOOPBACK).ok).toBe(true);
    });

    it('blocks a cross-site form post', () => {
        const result = checkRequestOrigin(
            request('POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
            LOOPBACK,
        );

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('cross-site');
    });

    it('blocks a foreign origin even without fetch metadata', () => {
        const result = checkRequestOrigin(request('POST', { origin: 'https://evil.example' }), LOOPBACK);

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('evil.example');
    });

    it('blocks a mismatched port on the same host', () => {
        expect(checkRequestOrigin(request('POST', { origin: 'http://127.0.0.1:9999' }), LOOPBACK).ok).toBe(false);
    });

    it('guards every write method', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const result = checkRequestOrigin(request(method, { origin: 'https://evil.example' }), LOOPBACK);
            expect(result.ok).toBe(false);
        }
    });

    /**
     * The board is as reachable at `localhost` as at `127.0.0.1`, and used to
     * render there and then refuse every write: the host check knew the name and
     * the origin check did not.
     */
    it('accepts a write from any spelling of loopback it serves', () => {
        for (const name of ['127.0.0.1', 'localhost', '[::1]']) {
            const origin = `http://${name}:8787`;
            const result = checkRequestOrigin(
                request('POST', { host: `${name}:8787`, origin, 'sec-fetch-site': 'same-origin' }),
                LOOPBACK,
            );

            expect(result.ok).toBe(true);
        }
    });

    describe('host', () => {
        it('accepts every name this server answers to', () => {
            for (const host of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787', 'LOCALHOST:8787']) {
                expect(checkRequestOrigin(request('POST', { host }), LOOPBACK).ok).toBe(true);
            }
        });

        /**
         * The rebinding case: the browser believes it is on evil.example, so it
         * sends no Origin and calls the request same-origin. Only the Host header
         * gives it away.
         */
        it('blocks a rebound host that looks same-origin', () => {
            const result = checkRequestOrigin(
                request('POST', { host: 'evil.example:8787', 'sec-fetch-site': 'same-origin' }),
                LOOPBACK,
            );

            expect(result.ok).toBe(false);
            expect(result.reason).toContain('evil.example');
        });

        it('blocks reads from a rebound host too', () => {
            expect(checkRequestOrigin(request('GET', { host: 'evil.example:8787' }), LOOPBACK).ok).toBe(false);
        });

        it('blocks the right host on the wrong port', () => {
            expect(checkRequestOrigin(request('POST', { host: '127.0.0.1:9999' }), LOOPBACK).ok).toBe(false);
        });
    });
});

describe('allowedOrigins', () => {
    it('answers to every spelling of loopback on its own port', () => {
        expect([...LOOPBACK.hosts].sort()).toEqual(['127.0.0.1:8787', '[::1]:8787', 'localhost:8787']);
        expect(LOOPBACK.origins.has('http://localhost:8787')).toBe(true);
    });

    it('drops the port a scheme implies, as a browser does', () => {
        const onEighty = allowedOrigins(80);

        expect(onEighty.hosts.has('localhost')).toBe(true);
        expect(onEighty.origins.has('http://localhost')).toBe(true);
        expect(onEighty.hosts.has('localhost:80')).toBe(false);
    });

    describe('with a declared origin', () => {
        // What `--bind 192.168.1.5` and `--origin` produce: reachable by another
        // name, without giving up the rebinding defence for every other name.
        const declared = allowedOrigins(8787, ['http://ci-deck.example:8787', 'https://deck.example']);

        it('answers to the name it was given', () => {
            const result = checkRequestOrigin(
                request('POST', {
                    host: 'ci-deck.example:8787',
                    origin: 'http://ci-deck.example:8787',
                    'sec-fetch-site': 'same-origin',
                }),
                declared,
            );

            expect(result.ok).toBe(true);
        });

        it('keeps answering to loopback', () => {
            expect(checkRequestOrigin(request('POST', { host: 'localhost:8787' }), declared).ok).toBe(true);
        });

        it('still blocks a name nobody declared', () => {
            expect(checkRequestOrigin(request('GET', { host: 'evil.example:8787' }), declared).ok).toBe(false);
        });

        it('does not confuse one declared origin with another', () => {
            const result = checkRequestOrigin(
                request('POST', { host: 'deck.example', origin: 'http://deck.example' }),
                declared,
            );

            // The host is declared, but only over https — an http page is not it.
            expect(result.ok).toBe(false);
            expect(result.reason).toContain('deck.example');
        });
    });
});
