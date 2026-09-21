import { describe, expect, it } from 'bun:test';
import type { GitLabStatus } from '../src/gitlab/types.ts';
import type { JobView, RepoView, StageView } from '../src/shared/types.ts';
import { contentKey } from '../web/stage-popover.ts';

function job(overrides: Partial<JobView> & { name: string; status: GitLabStatus }): JobView {
    return {
        id: 900,
        stage: 'build',
        allowFailure: false,
        durationSeconds: 42,
        webUrl: 'https://gitlab.test/-/jobs/900',
        startedAt: '2026-08-07T10:00:10Z',
        finishedAt: '2026-08-07T10:01:00Z',
        retriedAttempts: 0,
        ...overrides,
    };
}

function stage(jobs: JobView[]): StageView {
    return { name: 'build', status: 'success', hasManual: false, hasWarning: false, jobs };
}

function repo(stages: StageView[]): RepoView {
    return {
        id: 1,
        name: 'api-gateway',
        group: 'platform',
        tags: [],
        projectId: 7,
        ref: 'main',
        watched: true,
        notify: 'on',
        branchMissing: false,
        webUrl: 'https://gitlab.test/platform/api-gateway',
        health: 'ok',
        pipeline: null,
        stages,
        lastCheckedAt: '2026-08-07T10:02:00Z',
        lastError: null,
        checking: false,
    };
}

/**
 * The popover is rebuilt only when this changes, because rebuilding it takes the
 * buttons out from under the pointer and loses whatever click was on its way.
 * So the key has to move for everything the popover draws — and stay put for a
 * sweep that brought nothing new.
 */
describe('contentKey', () => {
    const jobs = [job({ name: 'bundle', status: 'success' }), job({ id: 901, name: 'compile', status: 'running' })];

    it('is unchanged by a sweep that found the same stage', () => {
        expect(contentKey(repo([stage(jobs)]), stage(jobs))).toBe(
            contentKey(repo([stage(jobs)]), stage(jobs)),
        );
    });

    it('moves when the stage headline changes', () => {
        const before = contentKey(repo([stage(jobs)]), stage(jobs));
        expect(contentKey(repo([stage(jobs)]), { ...stage(jobs), status: 'failed' })).not.toBe(before);
    });

    it('moves when a job changes status', () => {
        const before = contentKey(repo([stage(jobs)]), stage(jobs));
        const after = [jobs[0]!, { ...jobs[1]!, status: 'failed' as GitLabStatus }];
        expect(contentKey(repo([stage(after)]), stage(after))).not.toBe(before);
    });

    it('moves when a running job\'s duration ticks', () => {
        const before = contentKey(repo([stage(jobs)]), stage(jobs));
        const after = [jobs[0]!, { ...jobs[1]!, durationSeconds: 61 }];
        expect(contentKey(repo([stage(after)]), stage(after))).not.toBe(before);
    });

    /** A retry keeps the name and takes a new id — and the handlers close over it. */
    it('moves when a job is replaced by a new attempt', () => {
        const before = contentKey(repo([stage(jobs)]), stage(jobs));
        const after = [jobs[0]!, { ...jobs[1]!, id: 902, retriedAttempts: 1 }];
        expect(contentKey(repo([stage(after)]), stage(after))).not.toBe(before);
    });

    it('moves when a job joins or leaves the stage', () => {
        const before = contentKey(repo([stage(jobs)]), stage(jobs));
        const after = [...jobs, job({ id: 903, name: 'docker', status: 'created' })];
        expect(contentKey(repo([stage(after)]), stage(after))).not.toBe(before);
    });

    /** Nothing the popover shows, so nothing worth taking the buttons away for. */
    it('stays put for detail the popover does not draw', () => {
        const before = contentKey(repo([stage(jobs)]), stage(jobs));
        const after = [{ ...jobs[0]!, startedAt: '2026-08-07T11:00:00Z' }, jobs[1]!];
        expect(contentKey(repo([stage(after)]), stage(after))).toBe(before);
    });
});
