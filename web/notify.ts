import type { NotificationEvent } from '../src/shared/types.ts';
import { statusKind, statusLabel } from './status.ts';
import { toastInfo } from './toast.ts';

/**
 * Announcing a pipeline that has finished.
 *
 * Two limits are inherent rather than accidental. Browser notifications only
 * exist while a tab of the board is open — there is no service worker here, and
 * putting one behind a loopback app that already needs a running server buys
 * nothing. And sound cannot play until the page has been interacted with once,
 * which every browser enforces; the first click on the board unlocks it.
 */

/** Enough to be heard over a keyboard, short enough not to be a ringtone. */
const TONES: Record<string, number[]> = {
    success: [660, 880],
    failed: [440, 330],
    warning: [560, 470],
};

const DEFAULT_TONE = [620, 620];

let audio: AudioContext | null = null;

/**
 * Browsers refuse to start an AudioContext until the page has been used, and a
 * refused one stays refused. Built on the first gesture instead, which is also
 * the last moment before a notification could plausibly arrive.
 */
function unlock(): void {
    if (audio) {
        if (audio.state === 'suspended') void audio.resume();
        return;
    }
    const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    audio = new Ctor();
}

for (const event of ['pointerdown', 'keydown'] as const) {
    window.addEventListener(event, unlock, { once: false, passive: true });
}

/**
 * A two-note chime, synthesised rather than shipped: an audio file would be
 * another asset to serve, another licence to account for, and a `media-src` this
 * page's content policy does not otherwise need.
 */
export function chime(status: string): void {
    unlock();
    if (!audio || audio.state !== 'running') return;

    const notes = TONES[statusKind(status)] ?? DEFAULT_TONE;
    const start = audio.currentTime;

    notes.forEach((frequency, index) => {
        const at = start + index * 0.16;
        const oscillator = audio!.createOscillator();
        const gain = audio!.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(frequency, at);

        // Shaped rather than switched: a square-edged note clicks at both ends.
        gain.gain.setValueAtTime(0.0001, at);
        gain.gain.exponentialRampToValueAtTime(0.14, at + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.26);

        oscillator.connect(gain).connect(audio!.destination);
        oscillator.start(at);
        oscillator.stop(at + 0.3);
    });
}

export type PermissionState = 'unsupported' | 'default' | 'granted' | 'denied';

export function permission(): PermissionState {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission as PermissionState;
}

/** Asks once. A browser that has already refused is not asked again. */
export async function requestPermission(): Promise<PermissionState> {
    if (!('Notification' in window)) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission as PermissionState;

    try {
        return (await Notification.requestPermission()) as PermissionState;
    } catch {
        return permission();
    }
}

function body(event: NotificationEvent): string {
    const outcome = statusLabel(event.status);
    if (event.failedJobs.length === 0) return `${outcome} · pipeline #${event.pipelineIid}`;

    const shown = event.failedJobs.slice(0, 3).join(', ');
    const extra = event.failedJobs.length - 3;
    return `${outcome} · ${shown}${extra > 0 ? ` +${extra} more` : ''}`;
}

/**
 * Raises one notification. `silent` is snooze: the notification still happens,
 * it just does not make a sound — which is the setting for a repo you want to
 * know about without being pulled out of whatever you are doing.
 */
export function announce(event: NotificationEvent): void {
    const title = `${event.repo} · ${event.ref}`;

    if (permission() === 'granted') {
        try {
            const note = new Notification(title, {
                body: body(event),
                icon: '/assets/favicon.svg',
                // Keyed to the pipeline, so a second board tab replaces the first
                // one's notification instead of stacking a duplicate beside it.
                tag: `ci-deck:${event.repoId}:${event.pipelineIid}`,
                silent: event.silent,
            });
            note.addEventListener('click', () => {
                window.open(event.webUrl, '_blank', 'noreferrer');
                note.close();
            });
        } catch {
            // Some browsers throw on construction when the page is not visible.
            toastInfo(`${title} — ${body(event)}`);
        }
    } else {
        // Without permission the board says it in the only place it still can.
        toastInfo(`${title} — ${body(event)}`);
    }

    if (!event.silent) chime(event.status);
}
