export interface LaneOptions {
    /** Requests allowed to be in flight at once. */
    maxConcurrent: number;
    /** Minimum spacing between the start of two requests. */
    minGapMs?: number;
}

/**
 * A concurrency gate for outbound GitLab calls. Two lanes keep the sweep from
 * getting in the way of the user: the background lane is serialised and paced,
 * the interactive lane stays free for log reads, retries and ad-hoc checks.
 */
export class RequestLane {
    private readonly maxConcurrent: number;
    private readonly minGapMs: number;
    private readonly now: () => number;
    private readonly sleep: (ms: number) => Promise<void>;
    private waiting: (() => void)[] = [];
    private active = 0;
    private lastStart = 0;

    constructor(
        options: LaneOptions,
        deps: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
    ) {
        this.maxConcurrent = Math.max(1, options.maxConcurrent);
        this.minGapMs = Math.max(0, options.minGapMs ?? 0);
        this.now = deps.now ?? (() => Date.now());
        this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    }

    get inFlight(): number {
        return this.active;
    }

    get queued(): number {
        return this.waiting.length;
    }

    async run<T>(task: () => Promise<T>): Promise<T> {
        await this.acquire();
        try {
            return await task();
        } finally {
            this.release();
        }
    }

    private async acquire(): Promise<void> {
        if (this.active >= this.maxConcurrent) {
            // The slot is handed over on release, so `active` already counts us.
            await new Promise<void>((resolve) => this.waiting.push(resolve));
        } else {
            this.active += 1;
        }

        if (this.minGapMs === 0) {
            this.lastStart = this.now();
            return;
        }

        // Claim the slot before sleeping. Reading `lastStart`, sleeping, and only
        // then writing it lets concurrent acquirers all compute the same wait and
        // start together — harmless at maxConcurrent 1, a burst above it.
        const startAt = Math.max(this.now(), this.lastStart + this.minGapMs);
        this.lastStart = startAt;

        const wait = startAt - this.now();
        if (wait > 0) await this.sleep(wait);
    }

    private release(): void {
        const next = this.waiting.shift();
        if (next) next();
        else this.active -= 1;
    }
}
