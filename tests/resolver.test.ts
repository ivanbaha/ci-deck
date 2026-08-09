import { describe, expect, it } from 'bun:test';
import { groupFromPath, normalizeRepoInput, RepoResolutionError, resolveNewRepo } from '../src/core/resolver.ts';
import { GitLabClient } from '../src/gitlab/client.ts';
import type { GitLabProject } from '../src/gitlab/types.ts';

const HOST = 'https://gitlab.example.com';
const NAMESPACE = 'group/team/services';

function client(handler: (path: string) => GitLabProject | GitLabProject[]) {
    const calls: string[] = [];
    const instance = new GitLabClient({
        baseUrl: `${HOST}/`,
        token: 'glpat-test',
        fetchImpl: async (url) => {
            const path = decodeURIComponent(url.replace(`${HOST}/api/v4/`, ''));
            calls.push(path);
            return new Response(JSON.stringify(handler(path)), { status: 200 });
        },
    });
    return { instance, calls };
}

const project = (overrides: Partial<GitLabProject> = {}): GitLabProject => ({
    id: 100,
    name: 'my-service',
    path_with_namespace: `${NAMESPACE}/my-service`,
    web_url: `${HOST}/${NAMESPACE}/my-service`,
    default_branch: 'main',
    ...overrides,
});

describe('normalizeRepoInput', () => {
    it('keeps a bare repo name', () => {
        expect(normalizeRepoInput('  my-service  ')).toBe('my-service');
    });

    it('keeps a namespace path', () => {
        expect(normalizeRepoInput(`${NAMESPACE}/my-service`)).toBe(`${NAMESPACE}/my-service`);
    });

    it('extracts the path from a pipelines URL', () => {
        expect(normalizeRepoInput(`${HOST}/${NAMESPACE}/my-service/-/pipelines`)).toBe(
            `${NAMESPACE}/my-service`,
        );
    });

    it('handles any other project sub-route', () => {
        expect(normalizeRepoInput(`${HOST}/${NAMESPACE}/my-service/-/blob/main/package.json`)).toBe(
            `${NAMESPACE}/my-service`,
        );
    });

    it('drops query strings and trailing slashes', () => {
        expect(normalizeRepoInput(`${HOST}/${NAMESPACE}/my-service/?ref_type=heads`)).toBe(
            `${NAMESPACE}/my-service`,
        );
    });

    it('handles an ssh remote', () => {
        expect(normalizeRepoInput(`git@gitlab.example.com:${NAMESPACE}/my-service.git`)).toBe(
            `${NAMESPACE}/my-service`,
        );
    });

    it('handles an http clone url', () => {
        expect(normalizeRepoInput(`${HOST}/${NAMESPACE}/my-service.git`)).toBe(
            `${NAMESPACE}/my-service`,
        );
    });

    it('returns an empty string for blank input', () => {
        expect(normalizeRepoInput('   ')).toBe('');
    });
});

describe('groupFromPath', () => {
    it('uses the immediate namespace', () => {
        expect(groupFromPath('group/team/services/my-service')).toBe('services');
    });

    it('handles a top-level project', () => {
        expect(groupFromPath('me/my-service')).toBe('me');
    });

    it('falls back when there is no namespace', () => {
        expect(groupFromPath('my-service')).toBe('watched');
        expect(groupFromPath(null)).toBe('watched');
    });
});

describe('resolveNewRepo', () => {
    it('resolves a path straight through the project endpoint', async () => {
        const { instance, calls } = client(() => project());

        await expect(resolveNewRepo(instance, `${NAMESPACE}/my-service`)).resolves.toEqual({
            name: 'my-service',
            projectId: 100,
            path: `${NAMESPACE}/my-service`,
            group: 'services',
        });
        expect(calls).toEqual([`projects/${NAMESPACE}/my-service`]);
    });

    it('resolves a pasted browser URL', async () => {
        const { instance, calls } = client(() => project());

        const entry = await resolveNewRepo(instance, `${HOST}/${NAMESPACE}/my-service/-/pipelines`);

        expect(entry.projectId).toBe(100);
        expect(calls).toEqual([`projects/${NAMESPACE}/my-service`]);
    });

    it('searches by name when no path is given', async () => {
        const { instance, calls } = client(() => [project()]);

        const entry = await resolveNewRepo(instance, 'my-service');

        expect(entry.name).toBe('my-service');
        expect(calls[0]).toStartWith('projects?search=my-service');
    });

    it('carries an explicit ref and group', async () => {
        const { instance } = client(() => project());

        const entry = await resolveNewRepo(instance, `${NAMESPACE}/my-service`, {
            ref: 'develop',
            group: 'imported',
        });

        expect(entry.ref).toBe('develop');
        expect(entry.group).toBe('imported');
    });

    it('asks for a full path when the name is ambiguous', async () => {
        const { instance } = client(() => [
            project({ id: 1, name: 'shared', path_with_namespace: 'a/shared' }),
            project({ id: 2, name: 'shared', path_with_namespace: 'b/shared' }),
        ]);

        await expect(resolveNewRepo(instance, 'shared')).rejects.toThrow(/a\/shared, b\/shared/);
    });

    it('rejects a name GitLab does not know', async () => {
        const { instance } = client(() => []);

        await expect(resolveNewRepo(instance, 'nope-service')).rejects.toBeInstanceOf(RepoResolutionError);
    });

    it('rejects blank input', async () => {
        const { instance } = client(() => project());
        await expect(resolveNewRepo(instance, '  ')).rejects.toThrow(/required/);
    });
});
