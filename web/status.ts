import { CANCELABLE_JOB_STATUSES, RETRYABLE_JOB_STATUSES } from '../src/shared/statuses.ts';
import type { GitLabStatus, StageStatus } from '../src/shared/types.ts';
import type { IconName } from './icons.ts';

/**
 * GitLab enumerates thirteen job statuses; the board shows nine kinds. Collapsing
 * them is deliberate — no one can tell thirteen symbols apart in a 22px bubble,
 * and the distinctions that matter at a glance are "did it pass, is it moving,
 * does it want me". The exact word survives in `statusLabel`, which the badge,
 * the bubble tooltip and the job row all show.
 */
export type StatusKind =
    | 'success'
    | 'failed'
    | 'running'
    | 'pending'
    | 'warning'
    | 'canceled'
    | 'skipped'
    | 'manual'
    | 'neutral';

const KIND_BY_STATUS: Record<string, StatusKind> = {
    success: 'success',
    failed: 'failed',
    running: 'running',
    canceling: 'running',
    // Everything queued reads as pending, including `created`: it is a live job
    // that can be cancelled, not the absence of one, which is what neutral means.
    created: 'pending',
    pending: 'pending',
    preparing: 'pending',
    scheduled: 'pending',
    waiting_for_resource: 'pending',
    waiting_for_callback: 'pending',
    canceled: 'canceled',
    skipped: 'skipped',
    manual: 'manual',
    warning: 'warning',
};

const LABELS: Record<string, string> = {
    success: 'Passed',
    failed: 'Failed',
    running: 'Running',
    canceling: 'Canceling',
    pending: 'Pending',
    preparing: 'Preparing',
    created: 'Created',
    waiting_for_resource: 'Waiting for a resource',
    waiting_for_callback: 'Waiting for a callback',
    scheduled: 'Scheduled',
    canceled: 'Canceled',
    skipped: 'Skipped',
    manual: 'Manual',
    warning: 'Warning',
};

const ICONS: Record<StatusKind, IconName> = {
    success: 'status_success',
    failed: 'status_failed',
    running: 'status_running',
    pending: 'status_pending',
    warning: 'status_warning',
    canceled: 'status_canceled',
    skipped: 'status_skipped',
    manual: 'status_manual',
    neutral: 'status_neutral',
};

/** Anything GitLab adds after this was written lands on `neutral` rather than blank. */
export function statusKind(status: GitLabStatus | StageStatus | string): StatusKind {
    return KIND_BY_STATUS[status] ?? 'neutral';
}

export function statusLabel(status: GitLabStatus | StageStatus | string): string {
    return LABELS[status] ?? status;
}

export function statusIcon(kind: StatusKind): IconName {
    return ICONS[kind];
}

export function statusClass(status: GitLabStatus | StageStatus | string): string {
    return `s-${statusKind(status)}`;
}

// Defined next to the server's use of them, so a control the board offers and the
// jobs a stage-wide action touches can never disagree about what is retryable.
export const RETRYABLE = RETRYABLE_JOB_STATUSES;
export const CANCELABLE = CANCELABLE_JOB_STATUSES;
