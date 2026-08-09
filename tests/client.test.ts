import { describe, expect, it } from 'bun:test';
import { GitLabClient } from '../src/gitlab/client.ts';
import { GitLabAuthError, GitLabRequestError } from '../src/gitlab/errors.ts';

interface Harness {
    client: GitLabClient;
    calls: string[];
    delays: number[];
}

function harness(
    responder: (attempt: number, url: string) => Response | Promise<Response> | Error,
    retries = 5,
): Harness {
    const calls: string[] = [];
    const delays: number[] = [];

    const client = new GitLabClient({
        baseUrl: 'https://gitlab.test',
        token: 'glpat-test',
        retry: { retries, baseDelayMs: 1_000, maxDelayMs: 16_000 },
        sleep: async (ms) => {
            delays.push(ms);
        },
        fetchImpl: async (url) => {
            calls.push(url);
            const outcome = await responder(calls.length, url);
            if (outcome instanceof Error) throw outcome;
            return outcome;
        },
    });

    return { client, calls, delays };
}

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe('GitLabClient auth', () => {
    it('sends the token as a bearer header', async () => {
        let seen: Headers | undefined;
        const client = new GitLabClient({
            baseUrl: 'https://gitlab.test',
            token: 'glpat-test',
            fetchImpl: async (_url, init) => {
                seen = new Headers(init?.headers);
                return ok({ username: 'zbahiva' });
            },
        });

        await client.getCurrentUser();
        expect(seen?.get('authorization')).toBe('Bearer glpat-test');
    });

    it('builds the v4 api url from a base url without a trailing slash', async () => {
        const { client, calls } = harness(() => ok([]));
        await client.getLatestPipeline(42, 'main');
        expect(calls[0]).toStartWith('https://gitlab.test/api/v4/projects/42/pipelines?');
    });
});

describe('GitLabClient retries', () => {
    it('retries a 500 and succeeds without surfacing the error', async () => {
        const { client, calls, delays } = harness((attempt) =>
            attempt < 3 ? new Response('boom', { status: 500 }) : ok({ username: 'zbahiva' }),
        );

        await expect(client.getCurrentUser()).resolves.toEqual({ username: 'zbahiva' } as never);
        expect(calls).toHaveLength(3);
        expect(delays).toEqual([1_000, 2_000]);
    });

    it('backs off exponentially and caps at the max delay', async () => {
        const { client, delays } = harness(() => new Response('down', { status: 503 }), 6);

        await expect(client.getCurrentUser()).rejects.toBeInstanceOf(GitLabRequestError);
        expect(delays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 16_000]);
    });

    it('gives up after retries + 1 attempts', async () => {
        const { client, calls } = harness(() => new Response('down', { status: 502 }), 5);

        await expect(client.getCurrentUser()).rejects.toThrow(/after 6 attempts/);
        expect(calls).toHaveLength(6);
    });

    it('honours Retry-After on 429 instead of the backoff curve', async () => {
        const { client, delays } = harness((attempt) =>
            attempt === 1
                ? new Response('slow down', { status: 429, headers: { 'Retry-After': '7' } })
                : ok({ username: 'zbahiva' }),
        );

        await client.getCurrentUser();
        expect(delays).toEqual([7_000]);
    });

    it('retries network failures too', async () => {
        const { client, calls } = harness((attempt) =>
            attempt === 1 ? new Error('ECONNRESET') : ok({ username: 'zbahiva' }),
        );

        await client.getCurrentUser();
        expect(calls).toHaveLength(2);
    });

    it('never retries a rejected token', async () => {
        const { client, calls, delays } = harness(() => new Response('invalid token', { status: 401 }));

        await expect(client.getCurrentUser()).rejects.toBeInstanceOf(GitLabAuthError);
        expect(calls).toHaveLength(1);
        expect(delays).toEqual([]);
    });

    it('never retries a 404', async () => {
        const { client, calls } = harness(() => new Response('not found', { status: 404 }));

        await expect(client.getPipelineJobs(1, 2)).rejects.toBeInstanceOf(GitLabRequestError);
        expect(calls).toHaveLength(1);
    });
});

describe('GitLabClient pipelines', () => {
    it('asks for the newest pipeline of the ref only', async () => {
        const { client, calls } = harness(() => ok([{ id: 7 }]));

        const pipeline = await client.getLatestPipeline(42, 'main');

        expect(pipeline).toEqual({ id: 7 } as never);
        const query = new URL(calls[0]!).searchParams;
        expect(query.get('ref')).toBe('main');
        expect(query.get('per_page')).toBe('1');
        expect(query.get('sort')).toBe('desc');
    });

    it('returns null when the ref has no pipeline', async () => {
        const { client } = harness(() => ok([]));
        expect(await client.getLatestPipeline(42, 'main')).toBeNull();
    });

    it('posts to the documented retry and cancel endpoints', async () => {
        const { client, calls } = harness(() => ok({}));

        await client.retryJob(1, 10);
        await client.cancelJob(1, 11);
        await client.retryPipeline(1, 20);
        await client.cancelPipeline(1, 21);

        expect(calls.map((url) => url.replace('https://gitlab.test/api/v4/', ''))).toEqual([
            'projects/1/jobs/10/retry',
            'projects/1/jobs/11/cancel',
            'projects/1/pipelines/20/retry',
            'projects/1/pipelines/21/cancel',
        ]);
    });
});
