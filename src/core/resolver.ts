import type { GitLabClient } from '../gitlab/client.ts';
import type { GitLabProject } from '../gitlab/types.ts';
import type { NewRepo } from '../store/watch-store.ts';

export class RepoResolutionError extends Error { }

/**
 * Accepts whatever is on the clipboard: a bare repo name, a namespace path, a
 * browser URL of any project page, or an ssh remote. Everything collapses to the
 * `group/subgroup/repo` path GitLab needs.
 */
export function normalizeRepoInput(input: string): string {
    let value = input.trim();
    if (!value) return '';

    const ssh = /^git@[^:]+:(.+)$/.exec(value);
    if (ssh) value = ssh[1]!;

    if (/^https?:\/\//i.test(value)) {
        try {
            value = new URL(value).pathname;
        } catch {
            // Fall through and treat it as a path.
        }
    }

    // Drop GitLab's route suffix (`/-/pipelines`, `/-/tree/main`, …) and decorations.
    const [pathPart] = value.split('/-/');
    return (pathPart ?? '')
        .replace(/\.git$/i, '')
        .replace(/[?#].*$/, '')
        .replace(/^\/+|\/+$/g, '');
}

/** The namespace a project sits in, which makes a useful grouping on the board. */
export function groupFromPath(pathWithNamespace: string | null | undefined): string {
    const segments = (pathWithNamespace ?? '').split('/').filter(Boolean);
    return segments.length >= 2 ? segments[segments.length - 2]! : 'watched';
}

function toNewRepo(project: GitLabProject, ref: string | undefined, group?: string): NewRepo {
    return {
        name: project.name,
        projectId: project.id,
        path: project.path_with_namespace,
        group: group ?? groupFromPath(project.path_with_namespace),
        ...(ref ? { ref } : {}),
    };
}

async function lookupByName(client: GitLabClient, name: string): Promise<GitLabProject> {
    const query = new URLSearchParams({
        search: name,
        per_page: '20',
        simple: 'true',
        order_by: 'name',
    });
    const candidates = await client.requestJson<GitLabProject[]>(`projects?${query}`);
    const exact = candidates.filter((project) => project.name === name);

    if (exact.length === 1) return exact[0]!;

    if (exact.length > 1) {
        const paths = exact.map((project) => project.path_with_namespace).join(', ');
        throw new RepoResolutionError(
            `"${name}" matches several projects — add it by full path instead: ${paths}`,
        );
    }

    throw new RepoResolutionError(
        `No GitLab project named "${name}". Use the full path or paste the project URL.`,
    );
}

/** The one lookup both the add dialog and the add itself go through. */
export async function findProject(client: GitLabClient, input: string): Promise<GitLabProject> {
    const target = normalizeRepoInput(input);
    if (!target) throw new RepoResolutionError('Repo name or path is required');

    return target.includes('/') ? await client.getProject(target) : await lookupByName(client, target);
}

/**
 * Turns free-form input into a watch-list entry, resolving the project id once so
 * later sweeps never have to look it up again.
 */
export async function resolveNewRepo(
    client: GitLabClient,
    input: string,
    options: { ref?: string; group?: string } = {},
): Promise<NewRepo> {
    return toNewRepo(await findProject(client, input), options.ref, options.group);
}

/**
 * What the add dialog needs to offer a branch: the project it found, and the
 * branches on it. Typing a name is enough to learn whether the repo exists at
 * all, which used to only come back as an error after pressing Add.
 *
 * A project with no branches at all is not an error here — an empty repository
 * has none, and saying so is more use than a lookup failure.
 */
export async function describeProject(
    client: GitLabClient,
    input: string,
    maxBranches = 100,
): Promise<{ project: GitLabProject; branches: string[]; truncated: boolean }> {
    const project = await findProject(client, input);
    const branches = await client.getBranches(project.id, maxBranches);

    // The default branch first, then the rest as GitLab ordered them: it is what
    // all but a handful of rows will be watching.
    const ordered = project.default_branch && branches.includes(project.default_branch)
        ? [project.default_branch, ...branches.filter((name) => name !== project.default_branch)]
        : branches;

    return { project, branches: ordered, truncated: branches.length >= maxBranches };
}
