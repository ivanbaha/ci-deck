import { describe, expect, it } from 'bun:test';
import { RequestLane } from '../src/core/lane.ts';

function deferred<T = void>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('RequestLane', () => {
    it('runs one task at a time when serialised', async () => {
        const lane = new RequestLane({ maxConcurrent: 1 });
        const first = deferred();
        const order: string[] = [];
        let peak = 0;
        let active = 0;

        const task = (name: string, gate?: Promise<void>) =>
            lane.run(async () => {
                active += 1;
                peak = Math.max(peak, active);
                order.push(name);
                if (gate) await gate;
                active -= 1;
            });

        const a = task('a', first.promise);
        const b = task('b');

        await tick();
        expect(order).toEqual(['a']);
        expect(lane.queued).toBe(1);

        first.resolve();
        await Promise.all([a, b]);

        expect(order).toEqual(['a', 'b']);
        expect(peak).toBe(1);
        expect(lane.inFlight).toBe(0);
    });

    it('lets independent lanes overlap', async () => {
        const sweep = new RequestLane({ maxConcurrent: 1 });
        const interactive = new RequestLane({ maxConcurrent: 4 });
        const block = deferred();
        let interactiveDone = false;

        const busy = sweep.run(async () => {
            await block.promise;
        });
        const quick = interactive.run(async () => {
            interactiveDone = true;
        });

        await quick;
        expect(interactiveDone).toBe(true);

        block.resolve();
        await busy;
    });

    it('allows the configured amount of parallelism', async () => {
        const lane = new RequestLane({ maxConcurrent: 3 });
        const block = deferred();
        let peak = 0;
        let active = 0;

        const tasks = Array.from({ length: 6 }, () =>
            lane.run(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await block.promise;
                active -= 1;
            }),
        );

        await tick();
        expect(peak).toBe(3);

        block.resolve();
        await Promise.all(tasks);
        expect(peak).toBe(3);
    });

    it('paces starts by the minimum gap', async () => {
        let clock = 1_000;
        const slept: number[] = [];
        const lane = new RequestLane(
            { maxConcurrent: 1, minGapMs: 200 },
            {
                now: () => clock,
                sleep: async (ms) => {
                    slept.push(ms);
                    clock += ms;
                },
            },
        );

        await lane.run(async () => undefined);
        await lane.run(async () => undefined);
        clock += 500;
        await lane.run(async () => undefined);

        expect(slept).toEqual([200]);
    });

    it('keeps the gap between parallel starts, not just serial ones', async () => {
        const slept: number[] = [];
        const lane = new RequestLane(
            { maxConcurrent: 3, minGapMs: 100 },
            {
                now: () => 1_000,
                // Yields, so every acquirer reaches its wait before any resolves —
                // which is exactly when reading the deadline late lets them burst.
                sleep: (ms) =>
                    new Promise<void>((resolve) => {
                        slept.push(ms);
                        setTimeout(resolve, 0);
                    }),
            },
        );

        await Promise.all(Array.from({ length: 3 }, () => lane.run(async () => undefined)));

        // Three free slots: the deadline has to move for each claim, not once the
        // sleeping is over. Claiming late would make every waiter sleep the same
        // 100ms and start together.
        expect(slept).toEqual([100, 200]);
    });

    it('releases the slot when a task throws', async () => {
        const lane = new RequestLane({ maxConcurrent: 1 });

        await expect(lane.run(async () => {
            throw new Error('boom');
        })).rejects.toThrow('boom');

        expect(lane.inFlight).toBe(0);
        await expect(lane.run(async () => 'ok')).resolves.toBe('ok');
    });
});
