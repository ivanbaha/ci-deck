import { describe, expect, it } from 'bun:test';
import {
    maskToken,
    PlaintextProvider,
    providerForPlatform,
    Secrets,
    SecretError,
    type SecretProvider,
    type StoredSecret,
} from '../src/config/secrets.ts';

/** A store that accepts writes but hands back something else on read. */
class LyingProvider implements SecretProvider {
    readonly kind = 'keychain' as const;
    readonly secure = true;
    readonly label = 'lying store';

    async save(id: string): Promise<StoredSecret> {
        return { kind: this.kind, ref: id };
    }

    async read(): Promise<string | null> {
        return null;
    }

    async clear(): Promise<void> { }
}

class BrokenProvider implements SecretProvider {
    readonly kind = 'dpapi' as const;
    readonly secure = true;
    readonly label = 'broken store';

    async save(): Promise<StoredSecret> {
        throw new SecretError('credential store unavailable');
    }

    async read(): Promise<string | null> {
        return null;
    }

    async clear(): Promise<void> { }
}

describe('providerForPlatform', () => {
    it('prefers DPAPI on Windows', () => {
        expect(providerForPlatform('win32').kind).toBe('dpapi');
    });

    it('prefers the Keychain on macOS', () => {
        expect(providerForPlatform('darwin').kind).toBe('keychain');
    });

    it('falls back to plaintext elsewhere', () => {
        const provider = providerForPlatform('linux');
        expect(provider.kind).toBe('plaintext');
        expect(provider.secure).toBe(false);
    });
});

describe('Secrets', () => {
    it('round-trips through the plaintext store', async () => {
        const secrets = new Secrets(new PlaintextProvider());
        const outcome = await secrets.save('https://gitlab.test/', 'glpat-abc123');

        expect(outcome.provider.kind).toBe('plaintext');
        expect(outcome.fellBackFrom).toBeUndefined();
        expect(await secrets.read(outcome.stored)).toBe('glpat-abc123');
    });

    it('falls back to plaintext when the OS store refuses, and says why', async () => {
        const secrets = new Secrets(new BrokenProvider());
        const outcome = await secrets.save('https://gitlab.test/', 'glpat-abc123');

        expect(outcome.provider.kind).toBe('plaintext');
        expect(outcome.fellBackFrom).toContain('credential store unavailable');
        expect(await secrets.read(outcome.stored)).toBe('glpat-abc123');
    });

    it('refuses a store that cannot read back what it just wrote', async () => {
        // Verify-after-write turns a silently broken credential store into a clear error.
        const secrets = new Secrets(new LyingProvider(), new LyingProvider());

        await expect(secrets.save('https://gitlab.test/', 'glpat-abc123')).rejects.toThrow(
            /did not return the value/,
        );
    });

    it('reports an unreadable secret as null rather than throwing', async () => {
        const secrets = new Secrets(new PlaintextProvider());
        expect(await secrets.read({ kind: 'plaintext', ref: '' })).toBeNull();
    });

    it('survives a clear on a store that throws', async () => {
        const secrets = new Secrets(new BrokenProvider());
        await expect(secrets.clear({ kind: 'dpapi', ref: 'x' })).resolves.toBeUndefined();
    });
});

describe('maskToken', () => {
    it('keeps the prefix and the last four characters', () => {
        expect(maskToken('glpat-abcdefgh1234')).toBe('glpat-…1234');
    });

    it('masks a token with no known prefix', () => {
        expect(maskToken('abcdefgh1234')).toBe('…1234');
    });
});
