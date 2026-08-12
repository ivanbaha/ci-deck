/**
 * Which job statuses each control applies to. Shared rather than duplicated: the
 * browser decides whether to draw a control and the server decides which jobs a
 * stage-wide one touches, and two copies of that answer would drift the moment
 * GitLab adds another status.
 */

/** Statuses where "Retry" makes sense, matching GitLab's own affordances. */
export const RETRYABLE_JOB_STATUSES = new Set<string>([
    'failed',
    'canceled',
    'success',
    'skipped',
    'manual',
]);

export const CANCELABLE_JOB_STATUSES = new Set<string>([
    'running',
    'pending',
    'created',
    'preparing',
    'scheduled',
    'waiting_for_resource',
    'waiting_for_callback',
]);
