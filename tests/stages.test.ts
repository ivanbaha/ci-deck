import { describe, expect, it } from 'bun:test';
import { aggregateStageStatus, buildStages, extractCommit, toStageView } from '../src/core/stages.ts';
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

    /**
     * The one that used to go the other way. Something in the stage did fail, and
     * a stage that also happened to hold a manual job called itself manual and
     * showed no sign of the failure at all.
     */
    it('treats a warning as worse than a manual job waiting to be started', () => {
        expect(aggregateStageStatus([view('manual'), view('failed', true)])).toBe('warning');
    });

    it('is successful only when nothing else stands out', () => {
        expect(aggregateStageStatus([view('success'), view('skipped')])).toBe('success');
    });
});

/**
 * A stage is one bubble, so whatever wins above hides everything under it. The
 * two worth keeping are carried alongside the headline instead.
 */
describe('toStageView', () => {
    it('marks a manual job the headline had to bury', () => {
        const stage = toStageView('deploy', [view('failed'), view('manual')]);

        expect(stage.status).toBe('failed');
        expect(stage.hasManual).toBe(true);
        expect(stage.hasWarning).toBe(false);
    });

    it('marks an allow_failure failure the headline had to bury', () => {
        const stage = toStageView('test', [view('running'), view('failed', true)]);

        expect(stage.status).toBe('running');
        expect(stage.hasWarning).toBe(true);
    });

    it('does not call a hard failure a warning', () => {
        expect(toStageView('test', [view('failed')]).hasWarning).toBe(false);
    });

    it('says neither when there is nothing to say', () => {
        const stage = toStageView('build', [view('success')]);

        expect(stage.hasManual).toBe(false);
        expect(stage.hasWarning).toBe(false);
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
