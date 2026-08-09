import { describe, expect, it } from 'bun:test';
import { aggregateStageStatus, buildStages, extractCommit } from '../src/core/stages.ts';
import type { GitLabJob, GitLabStatus } from '../src/gitlab/types.ts';
import type { JobView } from '../src/shared/types.ts';

let nextId = 1;

function job(overrides: Partial<GitLabJob> & { stage: string; name: string; status: GitLabStatus }): GitLabJob {
    return {
        id: nextId++,
        allow_failure: false,
        created_at: '2026-08-07T10:00:00Z',
        started_at: '2026-08-07T10:00:10Z',
        finished_at: '2026-08-07T10:01:00Z',
        duration: 50,
        queued_duration: 1,
        web_url: `https://gitlab.test/jobs/${nextId}`,
        ...overrides,
    };
}

function view(status: GitLabStatus, allowFailure = false): JobView {
    return {
        id: nextId++,
        name: `job-${nextId}`,
        stage: 'test',
        status,
        allowFailure,
        durationSeconds: 1,
        webUrl: 'https://gitlab.test/jobs/1',
        startedAt: null,
        finishedAt: null,
        retriedAttempts: 0,
    };
}

describe('aggregateStageStatus', () => {
    it('reports an empty stage as skipped', () => {
        expect(aggregateStageStatus([])).toBe('skipped');
    });

    it('prefers running over any finished state', () => {
        expect(aggregateStageStatus([view('failed'), view('running'), view('success')])).toBe('running');
    });

    it('prefers a hard failure over queued jobs', () => {
        expect(aggregateStageStatus([view('pending'), view('failed')])).toBe('failed');
    });

    it('degrades an allow_failure-only failure to a warning', () => {
        expect(aggregateStageStatus([view('success'), view('failed', true)])).toBe('warning');
    });

    it('treats canceled as worse than manual', () => {
        expect(aggregateStageStatus([view('manual'), view('canceled')])).toBe('canceled');
    });

    it('is successful only when nothing else stands out', () => {
        expect(aggregateStageStatus([view('success'), view('skipped')])).toBe('success');
    });
});

describe('buildStages', () => {
    it('keeps stage order from job creation order, not alphabetical', () => {
        const jobs = [
            job({ stage: 'build', name: 'compile', status: 'success' }),
            job({ stage: 'test', name: 'unit', status: 'success' }),
            job({ stage: 'analyse', name: 'lint', status: 'failed' }),
        ];

        expect(buildStages(jobs).map((stage) => stage.name)).toEqual(['build', 'test', 'analyse']);
    });

    it('collapses retried attempts to the newest job and counts the rest', () => {
        const first = job({ stage: 'test', name: 'unit', status: 'failed' });
        const second = job({ stage: 'test', name: 'unit', status: 'success' });

        const [stage] = buildStages([first, second]);

        expect(stage!.jobs).toHaveLength(1);
        expect(stage!.jobs[0]!.id).toBe(second.id);
        expect(stage!.jobs[0]!.retriedAttempts).toBe(1);
        expect(stage!.status).toBe('success');
    });

    it('groups jobs of the same stage together', () => {
        const stages = buildStages([
            job({ stage: 'test', name: 'unit', status: 'success' }),
            job({ stage: 'test', name: 'e2e', status: 'failed' }),
        ]);

        expect(stages).toHaveLength(1);
        expect(stages[0]!.jobs.map((entry) => entry.name)).toEqual(['e2e', 'unit']);
        expect(stages[0]!.status).toBe('failed');
    });
});

describe('extractCommit', () => {
    it('takes the commit carried by the jobs', () => {
        const jobs = [
            job({ stage: 'build', name: 'compile', status: 'success' }),
            job({
                stage: 'test',
                name: 'unit',
                status: 'success',
                commit: { id: 'abcdef0123', short_id: 'abcdef01', title: 'fix: thing', author_name: 'Ivan' },
            }),
        ];

        expect(extractCommit(jobs)).toEqual({ shortId: 'abcdef01', title: 'fix: thing', authorName: 'Ivan' });
    });

    it('returns null when no job carries a commit', () => {
        expect(extractCommit([job({ stage: 'build', name: 'compile', status: 'success' })])).toBeNull();
    });
});
