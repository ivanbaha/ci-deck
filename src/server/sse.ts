import type { AppStore } from '../core/state.ts';

const KEEPALIVE_MS = 25_000;

/**
 * Server-sent events over a plain ReadableStream — the controller does the
 * buffering, so no queue of our own is needed.
 */
export function eventStream(store: AppStore): Response {
    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let keepalive: ReturnType<typeof setInterval> | null = null;

    const stream = new ReadableStream({
        start(controller) {
            let open = true;

            const write = (chunk: string) => {
                if (!open) return;
                try {
                    controller.enqueue(encoder.encode(chunk));
                } catch {
                    open = false;
                    cleanup();
                }
            };

            const cleanup = () => {
                unsubscribe?.();
                unsubscribe = null;
                if (keepalive) clearInterval(keepalive);
                keepalive = null;
            };

            write(`data: ${JSON.stringify({ type: 'snapshot', state: store.snapshot() })}\n\n`);
            unsubscribe = store.subscribe((event) => write(`data: ${JSON.stringify(event)}\n\n`));
            keepalive = setInterval(() => write(': ping\n\n'), KEEPALIVE_MS);
        },
        cancel() {
            unsubscribe?.();
            if (keepalive) clearInterval(keepalive);
        },
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            // Belt and braces for any proxy a user might put in front of it.
            'X-Accel-Buffering': 'no',
        },
    });
}
