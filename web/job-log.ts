import type { JobView, RepoView } from '../src/shared/types.ts';
import { ansiToHtml, tailLog } from './ansi.ts';
import { api } from './api.ts';
import { button } from './button.ts';
import { formatDuration, h } from './dom.ts';
import { icon } from './icons.ts';
import { openModal } from './modal.ts';
import { CANCELABLE, RETRYABLE, statusClass, statusIcon, statusKind, statusLabel } from './status.ts';
import { toastError, toastInfo } from './toast.ts';

const FOLLOW_INTERVAL_MS = 3_000;

function badge(status: string): HTMLElement {
    return h(
        'span',
        { class: `badge ${statusClass(status)}` },
        icon(statusIcon(statusKind(status)), 13),
        statusLabel(status),
    );
}

/** Same job across a retry: the id changes, the stage+name pair does not. */
function findJob(repo: RepoView, stage: string, name: string): JobView | undefined {
    return repo.stages.find((entry) => entry.name === stage)?.jobs.find((job) => job.name === name);
}

export function openJobLog(options: {
    repo: RepoView;
    stage: string;
    job: JobView;
    onRepo: (repo: RepoView) => void;
}): void {
    let job = options.job;
    let repoName = options.repo.name;
    let followTimer: ReturnType<typeof setInterval> | null = null;

    const terminal = h('pre', { class: 'terminal', tabindex: '0' }, 'Loading log…');
    const meta = h('span', { class: 'muted' });
    const followLabel = h('label', { class: 'field' });
    const followBox = h('input', { type: 'checkbox', id: 'follow-log' });
    const reload = button({ label: 'Reload the log', icon: 'refresh', text: 'Reload' });
    const retry = button({ label: `Retry ${job.name}`, icon: 'retry', text: 'Retry job' });
    const cancel = button({ label: `Cancel ${job.name}`, icon: 'cancel', text: 'Cancel job' });
    const open = h('a', { class: 'btn', href: job.webUrl, target: '_blank', rel: 'noreferrer', text: 'Open in GitLab' });

    followLabel.append(followBox, document.createTextNode(' Follow'));

    const modal = openModal({
        title: [badge(job.status), `${job.name}`, h('span', { class: 'muted', text: `· ${repoName} · ${options.stage}` })],
        flush: true,
        tall: true,
        onClose: () => {
            if (followTimer) clearInterval(followTimer);
        },
    });

    const syncControls = () => {
        modal.setTitle([
            badge(job.status),
            job.name,
            h('span', { class: 'muted', text: `· ${repoName} · ${options.stage}` }),
        ]);
        open.href = job.webUrl;
        retry.disabled = !RETRYABLE.has(job.status);
        cancel.disabled = !CANCELABLE.has(job.status);
        followBox.disabled = !CANCELABLE.has(job.status);

        const duration = formatDuration(job.durationSeconds);
        meta.textContent = [statusLabel(job.status), duration && `in ${duration}`, `job #${job.id}`]
            .filter(Boolean)
            .join(' · ');

        if (!CANCELABLE.has(job.status) && followTimer) {
            clearInterval(followTimer);
            followTimer = null;
            followBox.checked = false;
        }
    };

    const load = async (keepScroll: boolean) => {
        const atBottom = terminal.scrollTop + terminal.clientHeight >= terminal.scrollHeight - 40;
        try {
            const raw = await api.jobLog(repoName, job.id);
            const { text, truncated } = tailLog(raw);
            const html = ansiToHtml(text);
            terminal.innerHTML = html || '<span class="a-fg-90">No log output yet.</span>';
            if (truncated) {
                terminal.prepend(
                    h('span', { class: 'a-fg-93', text: '… earlier output trimmed, showing the tail\n\n' }),
                );
            }
            if (!keepScroll || atBottom) terminal.scrollTop = terminal.scrollHeight;
        } catch (error) {
            terminal.textContent = `Cannot load the log — ${error instanceof Error ? error.message : String(error)}`;
        }
    };

    const applyRepo = (repo: RepoView) => {
        repoName = repo.name;
        options.onRepo(repo);
        const updated = findJob(repo, options.stage, job.name);
        if (!updated) {
            toastInfo(`${job.name} is no longer part of the latest pipeline`);
            modal.close();
            return;
        }
        job = updated;
        syncControls();
        void load(false);
    };

    const act = async (action: 'retry' | 'cancel') => {
        retry.disabled = true;
        cancel.disabled = true;
        try {
            const result = action === 'retry'
                ? await api.retryJob(repoName, job.id)
                : await api.cancelJob(repoName, job.id);
            applyRepo(result.repo);
        } catch (error) {
            toastError(error);
            syncControls();
        }
    };

    reload.addEventListener('click', () => void load(false));
    retry.addEventListener('click', () => void act('retry'));
    cancel.addEventListener('click', () => void act('cancel'));
    followBox.addEventListener('change', () => {
        if (followTimer) {
            clearInterval(followTimer);
            followTimer = null;
        }
        if (followBox.checked) followTimer = setInterval(() => void load(true), FOLLOW_INTERVAL_MS);
    });

    modal.body.appendChild(terminal);
    modal.footer.append(meta, h('span', { class: 'spacer' }), followLabel, reload, cancel, retry, open);

    syncControls();
    if (CANCELABLE.has(job.status)) {
        followBox.checked = true;
        followTimer = setInterval(() => void load(true), FOLLOW_INTERVAL_MS);
    }
    void load(false);
}
