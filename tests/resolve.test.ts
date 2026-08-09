import { describe, expect, it } from 'bun:test';
import { resolveCredentials, type EnvLayers } from '../src/config/resolve.ts';
import { PlaintextProvider, Secrets } from '../src/config/secrets.ts';
import { WatchStore } from '../src/store/watch-store.ts';

const HOST = 'https://gitlab.example.com/';

const layers = (inline: Record<string, string> = {}, file: Record<string, string> = {}): EnvLayers => ({
    inline,
    file,
});

function stored(token = 'glpat-stored123'): { store: WatchStore; secrets: Secrets } {
    const store = WatchStore.memory();
    const secrets = new Secrets(new PlaintextProvider());
    store.setActiveBaseUrl(HOST);
    store.saveCredential(HOST, { kind: 'plaintext', ref: token }, 'stored-user');
    return { store, secrets };
}

describe('resolveCredentials priority', () => {
    it('is incomplete when nothing is configured anywhere', async () => {
        const resolved = await resolveCredentials(layers(), WatchStore.memory(), new Secrets(new PlaintextProvider()));

        expect(resolved.complete).toBe(false);
        expect(resolved.baseUrl.source).toBe('missing');
        expect(resolved.token.source).toBe('missing');
    });

    it('prefers inline over the env file', async () => {
        const resolved = await resolveCredentials(
            layers(
                { GITLAB_BASE_URL: 'https://inline.example.com/', GITLAB_PAT: 'glpat-inline' },
                { GITLAB_BASE_URL: 'https://file.example.com/', GITLAB_PAT: 'glpat-file' },
            ),
            WatchStore.memory(),
            new Secrets(new PlaintextProvider()),
        );

        expect(resolved.baseUrl.value).toBe('https://inline.example.com/');
        expect(resolved.baseUrl.source).toBe('inline');
        expect(resolved.token.value).toBe('glpat-inline');
        expect(resolved.token.source).toBe('inline');
    });

    it('prefers the env file over the store', async () => {
        const { store, secrets } = stored();
        const resolved = await resolveCredentials(
            layers({}, { GITLAB_PAT: 'glpat-file' }),
            store,
            secrets,
        );

        expect(resolved.token.value).toBe('glpat-file');
        expect(resolved.token.source).toBe('file');
        // The host still comes from the store, since the file did not set it.
        expect(resolved.baseUrl.source).toBe('store');
    });

    it('falls back to the store when the environment is silent', async () => {
        const { store, secrets } = stored();
        const resolved = await resolveCredentials(layers(), store, secrets);

        expect(resolved.complete).toBe(true);
        expect(resolved.baseUrl.value).toBe(HOST);
        expect(resolved.baseUrl.source).toBe('store');
        expect(resolved.token.value).toBe('glpat-stored123');
        expect(resolved.token.source).toBe('store');
        expect(resolved.token.storage).toBe('plaintext');
    });

    it('merges per value, not per source', async () => {
        const { store, secrets } = stored();
        const resolved = await resolveCredentials(
            layers({ GITLAB_BASE_URL: 'https://inline.example.com/' }),
            store,
            secrets,
        );

        expect(resolved.baseUrl.source).toBe('inline');
        expect(resolved.token.source).toBe('missing');
        // A host from the environment has no stored credential of its own yet.
        expect(resolved.complete).toBe(false);
    });

    it('masks the token it resolved and never exposes it twice', async () => {
        const { store, secrets } = stored('glpat-abcdefgh4f2a');
        const resolved = await resolveCredentials(layers(), store, secrets);

        expect(resolved.token.masked).toBe('glpat-…4f2a');
    });
});

describe('resolveCredentials validation', () => {
    it('reports a malformed base url instead of using it', async () => {
        const resolved = await resolveCredentials(
            layers({ GITLAB_BASE_URL: 'not-a-url' }),
            WatchStore.memory(),
            new Secrets(new PlaintextProvider()),
        );

        expect(resolved.baseUrl.value).toBeNull();
        expect(resolved.baseUrl.error).toContain('Not a valid URL');
        expect(resolved.complete).toBe(false);
    });

    it('reports a malformed token instead of using it', async () => {
        const resolved = await resolveCredentials(
            layers({ GITLAB_BASE_URL: HOST, GITLAB_PAT: 'has spaces' }),
            WatchStore.memory(),
            new Secrets(new PlaintextProvider()),
        );

        expect(resolved.token.value).toBeNull();
        expect(resolved.token.error).toContain('never has');
    });

    it('explains a stored token that cannot be read on this machine', async () => {
        const store = WatchStore.memory();
        store.setActiveBaseUrl(HOST);
        // An empty ref stands in for a DPAPI blob written by another user or machine.
        store.saveCredential(HOST, { kind: 'plaintext', ref: '' }, 'someone');

        const resolved = await resolveCredentials(layers(), store, new Secrets(new PlaintextProvider()));

        expect(resolved.token.value).toBeNull();
        expect(resolved.token.source).toBe('store');
        expect(resolved.token.error).toContain('could not be read on this machine');
    });
});
