import { platform } from 'node:os';

export type SecretKind = 'dpapi' | 'keychain' | 'plaintext';

/** What lands in the database: never the token itself, unless the kind says so. */
export interface StoredSecret {
    kind: SecretKind;
    ref: string;
}

export interface SecretProvider {
    readonly kind: SecretKind;
    /** False means the value sits in the database in the clear. */
    readonly secure: boolean;
    readonly label: string;
    save(id: string, secret: string): Promise<StoredSecret>;
    read(stored: StoredSecret): Promise<string | null>;
    clear(stored: StoredSecret): Promise<void>;
}

export class SecretError extends Error { }

interface CommandResult {
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Secrets go in over stdin, never as arguments — command lines are readable by
 * other processes on the same machine.
 */
async function run(cmd: string[], stdin?: string): Promise<CommandResult> {
    const child = Bun.spawn(cmd, {
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
    });

    const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);

    return { code, stdout, stderr };
}

const KEYCHAIN_SERVICE = 'ci-deck';

/**
 * Windows: DPAPI through PowerShell. The blob is tied to this user on this
 * machine, so a copied database cannot be decrypted elsewhere.
 */
export class DpapiProvider implements SecretProvider {
    readonly kind = 'dpapi' as const;
    readonly secure = true;
    readonly label = 'Windows DPAPI (user-scoped)';

    private static readonly ENCRYPT =
        '$ErrorActionPreference = "Stop"; ' +
        '$plain = [Console]::In.ReadToEnd().Trim(); ' +
        'ConvertTo-SecureString -String $plain -AsPlainText -Force | ConvertFrom-SecureString';

    private static readonly DECRYPT =
        '$ErrorActionPreference = "Stop"; ' +
        '$blob = [Console]::In.ReadToEnd().Trim(); ' +
        '$secure = ConvertTo-SecureString -String $blob; ' +
        '$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure); ' +
        'try { [Runtime.InteropServices.Marshal]::PtrToStringAuto($ptr) } ' +
        'finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }';

    private async powershell(script: string, stdin: string): Promise<string> {
        const result = await run(
            ['powershell.exe', '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            stdin,
        );
        if (result.code !== 0) {
            throw new SecretError(`PowerShell failed (${result.code}): ${result.stderr.trim().slice(0, 200)}`);
        }
        return result.stdout.trim();
    }

    async save(_id: string, secret: string): Promise<StoredSecret> {
        const ref = await this.powershell(DpapiProvider.ENCRYPT, secret);
        if (!ref) throw new SecretError('DPAPI returned an empty blob');
        return { kind: this.kind, ref };
    }

    async read(stored: StoredSecret): Promise<string | null> {
        const value = await this.powershell(DpapiProvider.DECRYPT, stored.ref);
        return value || null;
    }

    async clear(): Promise<void> {
        // The blob lives in the database; deleting the row is enough.
    }
}

/** macOS: a generic password item in the login keychain. */
export class KeychainProvider implements SecretProvider {
    readonly kind = 'keychain' as const;
    readonly secure = true;
    readonly label = 'macOS Keychain';

    async save(id: string, secret: string): Promise<StoredSecret> {
        // -U updates an existing item; the password arrives on stdin via -w with no value.
        const result = await run(
            ['security', 'add-generic-password', '-U', '-a', id, '-s', KEYCHAIN_SERVICE, '-w'],
            secret,
        );
        if (result.code !== 0) {
            throw new SecretError(`security add-generic-password failed: ${result.stderr.trim().slice(0, 200)}`);
        }
        return { kind: this.kind, ref: id };
    }

    async read(stored: StoredSecret): Promise<string | null> {
        const result = await run([
            'security',
            'find-generic-password',
            '-a',
            stored.ref,
            '-s',
            KEYCHAIN_SERVICE,
            '-w',
        ]);
        if (result.code !== 0) return null;
        return result.stdout.trim() || null;
    }

    async clear(stored: StoredSecret): Promise<void> {
        await run(['security', 'delete-generic-password', '-a', stored.ref, '-s', KEYCHAIN_SERVICE]);
    }
}

/** Last resort: the token sits in the database in the clear. */
export class PlaintextProvider implements SecretProvider {
    readonly kind = 'plaintext' as const;
    readonly secure = false;
    readonly label = 'plain text in the local database';

    async save(_id: string, secret: string): Promise<StoredSecret> {
        return { kind: this.kind, ref: secret };
    }

    async read(stored: StoredSecret): Promise<string | null> {
        return stored.ref || null;
    }

    async clear(): Promise<void> {
        // Nothing outside the database to remove.
    }
}

export function providerForPlatform(os: string = platform()): SecretProvider {
    if (os === 'win32') return new DpapiProvider();
    if (os === 'darwin') return new KeychainProvider();
    return new PlaintextProvider();
}

export interface SaveOutcome {
    stored: StoredSecret;
    provider: SecretProvider;
    /** Set when the preferred provider failed and plaintext was used instead. */
    fellBackFrom?: string;
}

/**
 * Chooses the best available store and always reads a secret back after writing
 * it — an OS credential store that silently refuses is worse than one that fails
 * loudly, and platform behaviour is the least predictable part of this.
 */
export class Secrets {
    private readonly preferred: SecretProvider;
    private readonly fallback: SecretProvider;

    constructor(preferred: SecretProvider = providerForPlatform(), fallback: SecretProvider = new PlaintextProvider()) {
        this.preferred = preferred;
        this.fallback = fallback;
    }

    get preferredProvider(): SecretProvider {
        return this.preferred;
    }

    get fallbackProvider(): SecretProvider {
        return this.fallback;
    }

    private async saveWith(provider: SecretProvider, id: string, secret: string): Promise<StoredSecret> {
        const stored = await provider.save(id, secret);
        const readBack = await provider.read(stored);
        if (readBack !== secret) {
            throw new SecretError(`${provider.label} did not return the value that was just stored`);
        }
        return stored;
    }

    async save(id: string, secret: string): Promise<SaveOutcome> {
        try {
            return { stored: await this.saveWith(this.preferred, id, secret), provider: this.preferred };
        } catch (error) {
            if (this.preferred.kind === this.fallback.kind) throw error;

            const reason = error instanceof Error ? error.message : String(error);
            return {
                stored: await this.saveWith(this.fallback, id, secret),
                provider: this.fallback,
                fellBackFrom: `${this.preferred.label} unavailable — ${reason}`,
            };
        }
    }

    providerFor(kind: SecretKind): SecretProvider {
        if (this.preferred.kind === kind) return this.preferred;
        if (this.fallback.kind === kind) return this.fallback;
        if (kind === 'dpapi') return new DpapiProvider();
        if (kind === 'keychain') return new KeychainProvider();
        return new PlaintextProvider();
    }

    /** Null when the secret cannot be read here, e.g. a DPAPI blob from another machine. */
    async read(stored: StoredSecret): Promise<string | null> {
        try {
            return await this.providerFor(stored.kind).read(stored);
        } catch {
            return null;
        }
    }

    async clear(stored: StoredSecret): Promise<void> {
        try {
            await this.providerFor(stored.kind).clear(stored);
        } catch {
            // Best effort: the database row goes away regardless.
        }
    }
}

/** `glpat-…4f2a` — enough to recognise a token without revealing it. */
export function maskToken(token: string): string {
    const tail = token.slice(-4);
    const prefix = token.startsWith('glpat-') ? 'glpat-' : '';
    return `${prefix}…${tail}`;
}
