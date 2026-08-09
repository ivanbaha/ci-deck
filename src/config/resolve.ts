import type { ValueSource } from '../shared/types.ts';
import type { WatchStore } from '../store/watch-store.ts';
import { normaliseBaseUrl, validateToken } from './env.ts';
import { maskToken, type Secrets } from './secrets.ts';

export type { ValueSource };

export interface ResolvedBaseUrl {
    value: string | null;
    source: ValueSource;
    /** Set when a value was present but unusable. */
    error: string | null;
}

export interface ResolvedToken {
    value: string | null;
    source: ValueSource;
    masked: string | null;
    /** How a stored token is protected: dpapi, keychain or plaintext. */
    storage: string | null;
    error: string | null;
}

export interface ResolvedCredentials {
    baseUrl: ResolvedBaseUrl;
    token: ResolvedToken;
    complete: boolean;
}

export interface EnvLayers {
    /** Variables already exported before any file was read. */
    inline: Record<string, string | undefined>;
    /** Variables the env file contributed. */
    file: Record<string, string>;
}

/**
 * Captures which layer each variable came from. The env file is applied to
 * `process.env` for anything not already set, so ordering falls out naturally.
 */
export function layerFor(key: string, layers: EnvLayers): ValueSource | null {
    if (layers.inline[key]?.trim()) return 'inline';
    if (layers.file[key]?.trim()) return 'file';
    return null;
}

function valueFor(key: string, layers: EnvLayers): string | null {
    return layers.inline[key]?.trim() || layers.file[key]?.trim() || null;
}

/**
 * Merges credentials per value, not per source: the host may come from the
 * environment while the token lives in the store.
 */
export async function resolveCredentials(
    layers: EnvLayers,
    store: WatchStore,
    secrets: Secrets,
): Promise<ResolvedCredentials> {
    const baseUrl = resolveBaseUrl(layers, store);
    const token = await resolveToken(layers, store, secrets, baseUrl.value);

    return { baseUrl, token, complete: Boolean(baseUrl.value && token.value) };
}

function resolveBaseUrl(layers: EnvLayers, store: WatchStore): ResolvedBaseUrl {
    const fromEnv = valueFor('GITLAB_BASE_URL', layers);

    if (fromEnv) {
        const source = layerFor('GITLAB_BASE_URL', layers) ?? 'inline';
        try {
            return { value: normaliseBaseUrl(fromEnv), source, error: null };
        } catch (error) {
            return { value: null, source, error: error instanceof Error ? error.message : String(error) };
        }
    }

    const stored = store.settings.activeBaseUrl;
    return stored
        ? { value: stored, source: 'store', error: null }
        : { value: null, source: 'missing', error: null };
}

async function resolveToken(
    layers: EnvLayers,
    store: WatchStore,
    secrets: Secrets,
    baseUrl: string | null,
): Promise<ResolvedToken> {
    const fromEnv = valueFor('GITLAB_PAT', layers);

    if (fromEnv) {
        const source = layerFor('GITLAB_PAT', layers) ?? 'inline';
        try {
            validateToken(fromEnv);
            return { value: fromEnv, source, masked: maskToken(fromEnv), storage: null, error: null };
        } catch (error) {
            return {
                value: null,
                source,
                masked: null,
                storage: null,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    const credential = baseUrl ? store.getCredential(baseUrl) : undefined;
    if (!credential) {
        return { value: null, source: 'missing', masked: null, storage: null, error: null };
    }

    const token = await secrets.read({ kind: credential.tokenKind, ref: credential.tokenRef });
    if (!token) {
        return {
            value: null,
            source: 'store',
            masked: null,
            storage: credential.tokenKind,
            // A DPAPI blob only decrypts for the user and machine that wrote it.
            error: 'The stored token could not be read on this machine. Enter it again.',
        };
    }

    return {
        value: token,
        source: 'store',
        masked: maskToken(token),
        storage: credential.tokenKind,
        error: null,
    };
}
