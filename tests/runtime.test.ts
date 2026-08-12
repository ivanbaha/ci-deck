import { describe, expect, it } from 'bun:test';
import { PlaintextProvider, Secrets } from '../src/config/secrets.ts';
import { ConfigureError, Runtime } from '../src/core/runtime.ts';
import { WatchStore } from '../src/store/watch-store.ts';

const HOST = 'https://gitlab.example.com/';

function runtimeWithStoredToken() {
    const watchStore = WatchStore.memory();
    watchStore.saveCredential(HOST, { kind: 'plaintext', ref: 'glpat-stored' }, 'me');
    watchStore.setActiveBaseUrl(HOST);

    const secrets = new Secrets(new PlaintextProvider(), new PlaintextProvider());
    return new Runtime({ watchStore, secrets, layers: { inline: {}, file: {} } });
}

describe('Runtime.configure', () => {
    /**
     * Verifying credentials means sending the token to whatever URL arrives, so a
     * request that changes only the host must not be able to reuse the saved one.
     * This has to fail before any request goes out.
     */
    it('refuses to send a stored token to a different instance', async () => {
        const runtime = runtimeWithStoredToken();

        const attempt = runtime.configure({ baseUrl: 'https://attacker.example/' });

        await expect(attempt).rejects.toBeInstanceOf(ConfigureError);
        await expect(attempt).rejects.toThrow(/only ever sent to https:\/\/gitlab\.example\.com\//);
    });

    it('names the instance the token would have to belong to', async () => {
        const runtime = runtimeWithStoredToken();

        await expect(runtime.configure({ baseUrl: 'https://attacker.example/' }))
            .rejects.toThrow(/https:\/\/attacker\.example\//);
    });

    it('still rejects a URL that is not usable at all', async () => {
        const runtime = runtimeWithStoredToken();

        await expect(runtime.configure({ baseUrl: 'https://gitlab.example.com/g/p/-/pipelines' }))
            .rejects.toThrow(/project page/);
    });
});

/**
 * Testing sends the token exactly where saving would, so it has to refuse in
 * exactly the same places. A check that could be pointed anywhere would be a way
 * around the rule above rather than a convenience.
 */
describe('Runtime.test', () => {
    it('refuses to send a stored token to a different instance', async () => {
        const runtime = runtimeWithStoredToken();

        const attempt = runtime.test({ baseUrl: 'https://attacker.example/' });

        await expect(attempt).rejects.toBeInstanceOf(ConfigureError);
        await expect(attempt).rejects.toThrow(/only ever sent to https:\/\/gitlab\.example\.com\//);
    });

    it('rejects a URL that is not an instance root', async () => {
        const runtime = runtimeWithStoredToken();

        await expect(runtime.test({ baseUrl: 'https://gitlab.example.com/g/p/-/pipelines' }))
            .rejects.toThrow(/project page/);
    });

    it('asks for a token when there is none to fall back on', async () => {
        const runtime = new Runtime({
            watchStore: WatchStore.memory(),
            secrets: new Secrets(new PlaintextProvider(), new PlaintextProvider()),
            layers: { inline: {}, file: {} },
        });

        await expect(runtime.test({ baseUrl: HOST })).rejects.toThrow(/access token is required/);
    });
});
