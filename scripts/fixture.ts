/**
 * A board full of repos, without a GitLab.
 *
 * Working on the UI otherwise means pointing a checkout at a real instance and
 * hoping something is red today. This serves a stand-in GitLab, seeds a watch
 * list against it, and starts the board on that database — one command, and every
 * state the board can draw is on screen at once.
 *
 * Usage: bun run fixture [--port <n>] [--gitlab-port <n>] [--keep]
 *
 * The world is generated from a fixed seed, so it is the same every run and a
 * screenshot means something. It is not static, though: pipelines that are
 * running advance on a cycle, so the board keeps moving while you watch it.
 *
 * Nothing here ships. It is not imported by `src/`, and the database it writes
 * lives in a gitignored directory of its own.
 */
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WatchStore } from '../src/store/watch-store.ts';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(projectRoot, '.fixture');
const dbPath = resolve(dataDir, 'ci-deck.db');

function numberFlag(name: string, fallback: number): number {
    const index = process.argv.indexOf(`--${name}`);
    if (index === -1) return fallback;

    const value = Number.parseInt(process.argv[index + 1] ?? '', 10);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) {
        throw new Error(`--${name} needs a port number`);
    }
    return value;
}

const boardPort = numberFlag('port', 8790);
const gitlabPort = numberFlag('gitlab-port', 8899);
/** Keeps a watch list you have been editing by hand, instead of rebuilding it. */
const keep = process.argv.includes('--keep');

const ORIGIN = `http://127.0.0.1:${gitlabPort}/`;

// --- the world -------------------------------------------------------------

/** mulberry32 — small, seeded, and good enough for fixtures. */
function rng(seed: number): () => number {
    let a = seed;
    return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const GROUPS = [
    { name: 'platform', repos: ['api-gateway', 'auth-service', 'billing-service', 'config-server', 'event-bus', 'rate-limiter', 'scheduler', 'webhook-relay'] },
    { name: 'payments', repos: ['ledger', 'payouts', 'reconciliation', 'settlement-engine', 'fx-rates', 'invoice-render'] },
    { name: 'web', repos: ['storefront', 'admin-console', 'design-system', 'docs-site', 'marketing-pages', 'checkout-ui', 'status-page'] },
    { name: 'data', repos: ['etl-runner', 'warehouse-sync', 'metrics-collector', 'report-builder', 'stream-processor', 'schema-registry'] },
    { name: 'mobile', repos: ['ios-app', 'android-app', 'release-tooling', 'push-gateway'] },
    { name: 'infra', repos: ['terraform-modules', 'k8s-manifests', 'runner-images', 'backup-agent', 'cert-rotator', 'log-shipper', 'dns-manager'] },
];

const STAGES = ['build', 'test', 'scan', 'deploy'] as const;

const JOB_NAMES: Record<string, string[]> = {
    build: ['compile', 'bundle', 'docker'],
    test: ['unit', 'integration', 'e2e', 'contract'],
    scan: ['lint', 'sast', 'licenses'],
    deploy: ['staging', 'production'],
};

const AUTHORS = ['Ada Okafor', 'Ravi Menon', 'Lena Fischer', 'Tomás Ruiz', 'Yuki Tanaka', 'Sam Whitfield'];

const TITLES = [
    'fix flaky reconnect in the consumer',
    'bump the runner image to 24.04',
    'drop the legacy /v1 handler',
    'cache the token lookup per request',
    'add a retry around the S3 put',
    'correct the timezone on daily rollups',
    'split the deploy job per region',
    'stop logging the full request body',
];

type Outcome = 'success' | 'failed' | 'running' | 'manual' | 'canceled' | 'warning' | 'none';

/**
 * One entry per repo, dealt rather than sampled: drawing independently gave a
 * board that was two thirds red often enough to be useless, and a fixture whose
 * spread changes with the seed is a fixture you cannot describe.
 *
 * The mix is a bad morning rather than a test matrix — mostly green, a handful of
 * red, enough in flight to watch it move. `warning` is the one worth keeping:
 * only an allow_failure job failed, so the stage is amber and the row is not red,
 * which is easy to get wrong.
 */
const OUTCOMES: Outcome[] = [
    ...Array<Outcome>(16).fill('success'),
    ...Array<Outcome>(7).fill('failed'),
    ...Array<Outcome>(6).fill('running'),
    ...Array<Outcome>(3).fill('manual'),
    ...Array<Outcome>(2).fill('canceled'),
    ...Array<Outcome>(2).fill('warning'),
    ...Array<Outcome>(2).fill('none'),
];

interface FixtureJob {
    id: number;
    name: string;
    stage: string;
    allowFailure: boolean;
    duration: number;
}

interface Project {
    id: number;
    name: string;
    group: string;
    path: string;
    outcome: Outcome;
    jobs: FixtureJob[];
    sha: string;
    title: string;
    author: string;
    /**
     * The job a failure lands on, chosen rather than positional. A `failed`
     * pipeline whose only failed job is `allow_failure` is a state GitLab never
     * produces — and it draws as a red row with no red stage and no failure hint,
     * which reads as a bug in the board.
     */
    failIndex: number;
    /** Seconds between job transitions, for the pipelines that are running. */
    tick: number;
    startedAt: number;
    pipelineId: number;
    /** Set by a retry or a cancel, and wins over the generated outcome. */
    override?: Outcome;
    jobOverrides: Map<number, string>;
}

/** Fisher–Yates, so the deck is shuffled but the same shuffle every run. */
function shuffled<T>(items: readonly T[], random: () => number): T[] {
    const deck = [...items];
    for (let i = deck.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    return deck;
}

function buildWorld(): Map<number, Project> {
    const random = rng(20260811);
    const world = new Map<number, Project>();
    const deck = shuffled(OUTCOMES, random);

    let nextId = 1000;
    let nextJobId = 500_000;
    let dealt = 0;

    for (const group of GROUPS) {
        for (const name of group.repos) {
            const id = (nextId += 1);
            const stageCount = 2 + Math.floor(random() * 3);

            const jobs: FixtureJob[] = STAGES.slice(0, stageCount).flatMap((stage) => {
                const names = JOB_NAMES[stage]!;
                return names.slice(0, 1 + Math.floor(random() * names.length)).map((jobName) => ({
                    id: (nextJobId += 1),
                    name: jobName,
                    stage,
                    // The two that are advisory in most pipelines.
                    allowFailure: jobName === 'licenses' || jobName === 'sast',
                    duration: Math.round(20 + random() * 400),
                }));
            });

            const outcome = deck[(dealt += 1) % deck.length]!;

            // An amber stage needs something allowed to fail. Short pipelines may
            // have drawn none, so give this one the job rather than drop the state.
            if (outcome === 'warning' && !jobs.some((job) => job.allowFailure)) {
                jobs.push({
                    id: (nextJobId += 1),
                    name: 'licenses',
                    stage: jobs[jobs.length - 1]!.stage,
                    allowFailure: true,
                    duration: 30,
                });
            }

            world.set(id, {
                id,
                name,
                group: group.name,
                path: `${group.name}/${name}`,
                outcome,
                jobs,
                failIndex: outcome === 'warning'
                    ? jobs.findIndex((job) => job.allowFailure)
                    // The last job that would actually fail the pipeline. Every
                    // repo has a build stage, so there is always one.
                    : jobs.findLastIndex((job) => !job.allowFailure),
                sha: Array.from({ length: 40 }, () => '0123456789abcdef'[Math.floor(random() * 16)]).join(''),
                title: TITLES[Math.floor(random() * TITLES.length)]!,
                author: AUTHORS[Math.floor(random() * AUTHORS.length)]!,
                tick: 8 + Math.floor(random() * 12),
                startedAt: Date.now() - Math.floor(random() * 3600) * 1000,
                pipelineId: 90_000 + id,
                jobOverrides: new Map(),
            });
        }
    }

    return world;
}

const projects = buildWorld();
const byPath = new Map([...projects.values()].map((project) => [project.path, project]));

// --- what the board sees ---------------------------------------------------

/** How far a running pipeline has got. It loops, so the board never settles. */
function progress(project: Project): number {
    const cycle = (project.jobs.length + 3) * project.tick;
    return Math.floor((((Date.now() - project.startedAt) / 1000) % cycle) / project.tick);
}

function jobStatus(project: Project, index: number, total: number): string {
    switch (project.override ?? project.outcome) {
        case 'none':
            return 'created';
        case 'success':
            return 'success';
        case 'canceled':
            return index === 0 ? 'success' : 'canceled';
        case 'manual':
            return index >= total - 1 ? 'manual' : 'success';
        case 'warning':
            return index === project.failIndex ? 'failed' : 'success';
        case 'failed':
            if (index === project.failIndex) return 'failed';
            // Everything after a hard failure never ran.
            return index > project.failIndex ? 'skipped' : 'success';
        case 'running': {
            const done = progress(project);
            if (index < done) return 'success';
            if (index === done) return 'running';
            return index === done + 1 ? 'pending' : 'created';
        }
    }
}

function pipelineStatus(project: Project): string {
    const outcome = project.override ?? project.outcome;
    // An allow_failure job failing does not fail the pipeline.
    if (outcome === 'warning') return 'success';
    if (outcome === 'none') return 'created';
    if (outcome === 'running') return progress(project) >= project.jobs.length ? 'success' : 'running';
    return outcome;
}

const iso = (ms: number) => new Date(ms).toISOString();

const projectJson = (project: Project) => ({
    id: project.id,
    name: project.name,
    path_with_namespace: project.path,
    web_url: `${ORIGIN}${project.path}`,
    default_branch: 'main',
});

function pipelineJson(project: Project) {
    const running = (project.override ?? project.outcome) === 'running';

    return {
        id: project.pipelineId,
        iid: project.id - 900,
        project_id: project.id,
        sha: project.sha,
        ref: 'main',
        status: pipelineStatus(project),
        source: 'push',
        web_url: `${ORIGIN}${project.path}/-/pipelines/${project.pipelineId}`,
        created_at: iso(project.startedAt),
        // A running pipeline keeps moving, so its jobs are never served from cache.
        updated_at: iso(running ? Date.now() - 5_000 : project.startedAt + 600_000),
    };
}

function jobsJson(project: Project) {
    const commit = {
        id: project.sha,
        short_id: project.sha.slice(0, 8),
        title: project.title,
        author_name: project.author,
    };

    return project.jobs.map((job, index) => {
        const status = project.jobOverrides.get(job.id) ?? jobStatus(project, index, project.jobs.length);
        const started = project.startedAt + index * job.duration * 1000;
        const settled = status === 'success' || status === 'failed' || status === 'canceled';

        return {
            id: job.id,
            name: job.name,
            stage: job.stage,
            status,
            allow_failure: job.allowFailure,
            created_at: iso(project.startedAt),
            started_at: status === 'created' || status === 'manual' ? null : iso(started),
            finished_at: settled ? iso(started + job.duration * 1000) : null,
            duration: settled ? job.duration : null,
            queued_duration: 2,
            web_url: `${ORIGIN}${project.path}/-/jobs/${job.id}`,
            commit,
        };
    });
}

/**
 * A trace with the three things the log viewer exists to handle: SGR colour it
 * keeps, section markers it strips, and a progress bar redrawn in place with
 * carriage returns, which it collapses to the final state.
 */
function trace(project: Project, jobId: number): string {
    const job = project.jobs.find((entry) => entry.id === jobId);
    const status = jobsJson(project).find((entry) => entry.id === jobId)?.status ?? 'unknown';
    const now = Math.floor(Date.now() / 1000);

    const lines = [
        `section_start:${now}:prepare_executor\r[0K[36;1mPreparing the "docker" executor[0;m`,
        'Using Docker executor with image node:24-alpine ...',
        `section_end:${now}:prepare_executor\r[0K`,
        `section_start:${now}:get_sources\r[0K[36;1mGetting source from Git repository[0;m`,
        '[32;1mFetching changes...[0;m',
        `Checking out ${project.sha.slice(0, 8)} as [1mmain[0m...`,
        `section_end:${now}:get_sources\r[0K`,
        `$ ${job?.name ?? 'script'} --ci`,
        // One line redrawn twelve times, the way a runner emits it. Twelve separate
        // lines would look the same in the file and prove nothing in the viewer.
        Array.from(
            { length: 12 },
            (_, i) => `Progress: ${'█'.repeat(i)}${'░'.repeat(11 - i)} ${Math.round(((i + 1) / 12) * 100)}%`,
        ).join('\r'),
        '',
        '[90m[10:02:14][0m resolving 421 modules',
        '[90m[10:02:18][0m [33mwarning[0m  two peer dependencies unmet',
        '[90m[10:02:31][0m 128 assertions, [32m126 passed[0m',
    ];

    if (status === 'failed') {
        lines.push(
            '[90m[10:02:31][0m [31;1m2 failed[0m',
            '',
            `[31;1m  ● ${project.name} › ${job?.name ?? 'suite'} › retries on a closed socket[0m`,
            '',
            '    Expected: [32m"reconnected"[0m',
            '    Received: [31mundefined[0m',
            '',
            '      at Object.<anonymous> (test/socket.test.ts:118:24)',
            '',
            '[31;1mERROR: Job failed: exit code 1[0;m',
        );
    } else if (status === 'success') {
        lines.push('', `[32;1mJob succeeded[0;m in ${job?.duration ?? 0}s`);
    } else {
        lines.push('', '[36mstill running…[0m');
    }

    return `${lines.join('\n')}\n`;
}

// --- the instance ----------------------------------------------------------

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ message: '404 Not Found' }, 404);

const gitlab = Bun.serve({
    hostname: '127.0.0.1',
    port: gitlabPort,
    idleTimeout: 0,
    fetch(request) {
        const url = new URL(request.url);
        const path = url.pathname;

        // Any token is accepted, so the setup dialog can be exercised too — but an
        // absent one still 401s, which is the state the board has to survive.
        if (!request.headers.get('authorization')) return json({ message: '401 Unauthorized' }, 401);

        if (path === '/api/v4/user') {
            return json({ id: 1, username: 'fixture-user', name: 'Fixture User' });
        }

        // How a repo added by bare name is resolved.
        if (path === '/api/v4/projects') {
            const search = (url.searchParams.get('search') ?? '').toLowerCase();
            const perPage = Math.min(Number(url.searchParams.get('per_page') ?? 20) || 20, 100);
            return json(
                [...projects.values()]
                    .filter((project) => project.name.toLowerCase().includes(search))
                    .slice(0, perPage)
                    .map(projectJson),
            );
        }

        const parts = path.replace('/api/v4/projects/', '').split('/');
        const key = decodeURIComponent(parts[0] ?? '');
        const project = projects.get(Number(key)) ?? byPath.get(key);
        if (!project) return notFound();

        if (parts.length === 1) return json(projectJson(project));

        if (parts[1] === 'pipelines' && parts.length === 2) {
            const empty = (project.override ?? project.outcome) === 'none';
            return json(empty ? [] : [pipelineJson(project)]);
        }

        if (parts[1] === 'pipelines' && parts[3] === 'jobs') return json(jobsJson(project));

        if (parts[1] === 'pipelines' && (parts[3] === 'retry' || parts[3] === 'cancel')) {
            project.override = parts[3] === 'retry' ? 'running' : 'canceled';
            project.startedAt = Date.now();
            project.jobOverrides.clear();
            return json(pipelineJson(project));
        }

        if (parts[1] === 'jobs') {
            const jobId = Number(parts[2]);
            const job = project.jobs.find((entry) => entry.id === jobId);
            if (!job) return notFound();

            if (parts[3] === 'trace') {
                return new Response(trace(project, jobId), {
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                });
            }
            if (parts[3] === 'retry' || parts[3] === 'play') {
                project.jobOverrides.set(jobId, 'running');
                return json({ id: jobId, name: job.name, status: 'running' });
            }
            if (parts[3] === 'cancel') {
                project.jobOverrides.set(jobId, 'canceled');
                return json({ id: jobId, name: job.name, status: 'canceled' });
            }
        }

        return notFound();
    },
});

// --- the watch list --------------------------------------------------------

/** Tags cut across namespaces, which is the whole point of them. */
const TAGS: Record<string, string[]> = {
    'release-blocking': ['api-gateway', 'auth-service', 'ledger', 'checkout-ui', 'storefront'],
    'on-call': ['api-gateway', 'event-bus', 'payouts', 'stream-processor', 'log-shipper'],
    frontend: ['storefront', 'admin-console', 'design-system', 'checkout-ui', 'status-page'],
    'needs-owner': ['backup-agent', 'dns-manager', 'release-tooling'],
    quiet: [],
};

/** Two paused rows, so the bottom of the board has something to show. */
const PAUSED = ['docs-site', 'marketing-pages'];

function seed(): number {
    if (!keep) rmSync(dataDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });

    const store = WatchStore.open(dbPath);
    store.setActiveBaseUrl(ORIGIN);
    store.saveCredential(ORIGIN, { kind: 'plaintext', ref: 'glpat-fixture' }, 'fixture-user');

    if (store.countFor(ORIGIN) === 0) {
        for (const project of projects.values()) {
            store.addRepo({
                name: project.name,
                projectId: project.id,
                path: project.path,
                group: project.group,
                baseUrl: ORIGIN,
                watched: !PAUSED.includes(project.name),
            });
        }

        for (const [tag, repos] of Object.entries(TAGS)) {
            store.createTag(ORIGIN, tag);
            if (repos.length > 0) store.setTagRepos(ORIGIN, tag, repos);
        }

        store.setPollPeriod(30);
    }

    const total = store.countFor(ORIGIN);
    store.close();
    return total;
}

const watched = seed();

console.log(`\n  Fixture GitLab   ${ORIGIN}`);
console.log(`  Watch list       ${watched} repos across ${GROUPS.length} groups, ${Object.keys(TAGS).length} tags`);
console.log(`  Database         ${dbPath}${keep ? ' (kept)' : ''}`);

// --- the board -------------------------------------------------------------

// The real entrypoint rather than a copy of its startup, so this exercises what
// ships — the banner below is the board's own.
const board = Bun.spawn(
    [process.execPath, 'run', resolve(projectRoot, 'src/cli.ts'), '--db', dbPath, '--port', String(boardPort)],
    {
        cwd: projectRoot,
        // The tag interface ships dark; a fixture is exactly where to look at it.
        env: { ...process.env, CI_DECK_TAGS: '1' },
        stdout: 'inherit',
        stderr: 'inherit',
    },
);

const stop = async () => {
    board.kill();
    await board.exited;
    gitlab.stop(true);
    process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// A board that could not start — a port already held, most likely — should not
// leave a fixture instance running behind it.
const code = await board.exited;
gitlab.stop(true);
process.exit(code ?? 0);
