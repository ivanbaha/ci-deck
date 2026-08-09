import { describe, expect, it } from 'bun:test';
import { checkRequestOrigin } from '../src/server/guard.ts';

const SELF = 'http://127.0.0.1:8787';

const request = (method: string, headers: Record<string, string> = {}) =>
    new Request(`${SELF}/api/repos/alpha/pipeline/retry`, { method, headers });

describe('checkRequestOrigin', () => {
    it('allows reads regardless of provenance', () => {
        expect(checkRequestOrigin(request('GET', { origin: 'https://evil.example' }), SELF).ok).toBe(true);
    });

    it('allows a write from our own page', () => {
        const result = checkRequestOrigin(
            request('POST', { origin: SELF, 'sec-fetch-site': 'same-origin' }),
            SELF,
        );
        expect(result.ok).toBe(true);
    });

    it('allows a header-less client such as curl', () => {
        expect(checkRequestOrigin(request('POST'), SELF).ok).toBe(true);
    });

    it('allows a direct address-bar navigation', () => {
        expect(checkRequestOrigin(request('POST', { 'sec-fetch-site': 'none' }), SELF).ok).toBe(true);
    });

    it('blocks a cross-site form post', () => {
        const result = checkRequestOrigin(
            request('POST', { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }),
            SELF,
        );

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('cross-site');
    });

    it('blocks a foreign origin even without fetch metadata', () => {
        const result = checkRequestOrigin(request('POST', { origin: 'https://evil.example' }), SELF);

        expect(result.ok).toBe(false);
        expect(result.reason).toContain('evil.example');
    });

    it('blocks a mismatched port on the same host', () => {
        expect(checkRequestOrigin(request('POST', { origin: 'http://127.0.0.1:9999' }), SELF).ok).toBe(false);
    });

    it('guards every write method', () => {
        for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
            const result = checkRequestOrigin(request(method, { origin: 'https://evil.example' }), SELF);
            expect(result.ok).toBe(false);
        }
    });

    describe('host', () => {
        it('accepts every name this server binds to', () => {
            for (const host of ['127.0.0.1:8787', 'localhost:8787', '[::1]:8787', 'LOCALHOST:8787']) {
                expect(checkRequestOrigin(request('POST', { host }), SELF).ok).toBe(true);
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
                SELF,
            );

            expect(result.ok).toBe(false);
            expect(result.reason).toContain('evil.example');
        });

        it('blocks reads from a rebound host too', () => {
            expect(checkRequestOrigin(request('GET', { host: 'evil.example:8787' }), SELF).ok).toBe(false);
        });

        it('blocks the right host on the wrong port', () => {
            expect(checkRequestOrigin(request('POST', { host: '127.0.0.1:9999' }), SELF).ok).toBe(false);
        });
    });
});
