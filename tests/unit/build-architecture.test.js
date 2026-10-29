import { describe, it, expect } from 'vitest';
import { buildArchitecture, unknownHosts, renderHTML, renderMermaid, updateReadme } from '../../scripts/build-architecture.mjs';

// These run against the real repository. The generator reads source with
// patterns, so the failure to guard against is a pattern that quietly stops
// matching and drops a table or a route from the diagram. Each case pins an
// answer read by hand from the code; when the code changes on purpose, change
// the expectation with it.
const arch = buildArchitecture();
const route = (method, path) => arch.routes.find((r) => r.method === method && r.path === path);
const table = (name) => arch.schema.tables.find((t) => t.name === name);
const job = (name) => arch.jobs.find((j) => j.name === name);

describe('routes', () => {
    it('finds every registration in newMux, once', () => {
        const keys = arch.routes.map((r) => `${r.method} ${r.path}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect(keys).toContain('GET /metrics');
        expect(keys).toContain('POST /api/auth/google');
        expect(keys).toContain('DELETE /api/commutes/{id}');
    });

    it('follows a handler to every table it writes', () => {
        expect(route('DELETE', '/api/auth/account').writes)
            .toEqual(['commutes', 'refresh_tokens', 'users', 'verification_tokens']);
    });

    it('follows helper calls to third parties', () => {
        expect(route('POST', '/api/auth/register').externals).toEqual(['resend']);
        expect(route('POST', '/api/auth/google').externals).toEqual(['google']);
    });

    it('reads middleware chains and feature gates', () => {
        const plan = route('GET', '/api/plan');
        expect(plan.chain).toEqual(['optionalAuth', 'requireFeature(trip_planner)']);
        expect(plan.variants).toHaveLength(1);
        expect(route('GET', '/api/commutes').feature).toBe('saved_commutes');
        expect(route('PATCH', '/api/commutes/{id}').feature).toBeNull();
        expect(route('GET', '/api/auth/me').access).toBe('auth');
    });

    it('does not pull in code a handler never calls', () => {
        expect(route('GET', '/health').writes).toEqual([]);
        expect(route('GET', '/api/plan').caches).not.toContain('gtfsFiles');
    });

    it('records non-browser callers from fly.toml', () => {
        expect(route('GET', '/health').pingsDatabase).toBe(true);
        expect(route('GET', '/health').machineCallers[0]).toMatch(/^Fly health check/);
        expect(route('GET', '/metrics').machineCallers[0]).toMatch(/Prometheus/);
    });

    it('lists middleware in the order requests pass through it', () => {
        expect(arch.middleware.map((m) => m.name))
            .toEqual(['metricsMiddleware', 'rateLimitMiddleware', 'corsMiddleware', 'gzipMiddleware']);
        expect(arch.middleware[1].detail).toBe('Per-IP token bucket: 10 req/s, burst 30, 429 when empty');
    });

    it('reads per-route rate limits, outermost first', () => {
        expect(arch.routeLimiters).toEqual([expect.objectContaining({ name: 'passwordLimit', perMinute: 10, burst: 5 })]);
        expect(route('POST', '/api/auth/login').chain).toEqual(['passwordLimit']);
        expect(route('POST', '/api/auth/change-password').chain).toEqual(['passwordLimit', 'requireAuth']);
        expect(route('POST', '/api/auth/refresh').chain).toEqual([]);
    });
});

describe('schema', () => {
    it('replays migrations, including a dropped constraint', () => {
        const users = table('users');
        expect(users.columns.find((c) => c.name === 'email').unique).toBe(false);
        expect(users.indexes).toContainEqual(expect.objectContaining({
            name: 'users_email_active_key', unique: true, where: 'deleted_at IS NULL',
        }));
    });

    it('reads foreign keys and seeds', () => {
        expect(table('refresh_tokens').columns.find((c) => c.name === 'user_id').fk)
            .toEqual({ table: 'users', column: 'id', onDelete: 'CASCADE' });
        expect(table('features').seeds).toContain('saved_commutes');
    });
});

describe('jobs', () => {
    it('reads intervals and what each job fills', () => {
        expect(job('startFeedRefresher')).toMatchObject({ interval: '30s', externals: ['mta-rt'], caches: ['feeds'] });
        expect(job('startAccountCleanup')).toMatchObject({ interval: '1h', needsDatabase: true });
        expect(job('startAccountCleanup').writes).toContain('users');
    });
});

describe('hosts', () => {
    it('knows every host the code calls', () => {
        expect(unknownHosts()).toEqual([]);
    });
});

describe('renderHTML', () => {
    it('cannot be broken out of its script tag by the data', () => {
        const html = renderHTML('{"x":"</script><b>"}', '<script>__ARCH_DATA__</script>');
        expect(html).toContain('<script>{"x":"\\u003c/script>\\u003cb>"}</script>');
    });
});

describe('renderMermaid', () => {
    const { requests, jobs } = renderMermaid(arch);

    it('shows every table with its primary key', () => {
        for (const t of arch.schema.tables) {
            const pk = t.columns.filter((c) => c.pk).map((c) => c.name).join(', ');
            expect(requests + jobs).toContain(`[("${t.name}<br/>PK ${pk}")]`);
        }
    });

    it('draws the third parties a request reaches and a job fetches', () => {
        expect(requests).toContain('r_auth --> x_resend');
        expect(requests).toContain('x_fly_prom -->|scrapes| r_metrics');
        expect(jobs).toContain('x_mta_rt -->|fetches| j_startFeedRefresher');
        expect(jobs).toContain('j_startAccountCleanup -->|writes| t_users');
    });

    it('keeps node ids and labels inside what Mermaid parses', () => {
        for (const line of (requests + jobs).split('\n')) {
            const node = line.match(/^\s+(\w+)[[(]/);
            if (node) expect(node[1]).toMatch(/^[A-Za-z0-9_]+$/);
            const label = line.match(/"([^"]*)"/g)?.join('') ?? '';
            expect(label.replace(/<br\/>/g, '')).not.toMatch(/[<>]/);
        }
        expect(renderMermaid({ ...arch, caches: [{ id: 'feeds', label: 'a "<b>" cache' }, ...arch.caches.slice(1)] }).requests)
            .toContain('a #quot;#lt;b#gt;#quot; cache');
    });
});

describe('updateReadme', () => {
    const charts = { requests: 'flowchart LR\n    a --> b\n', jobs: 'flowchart LR\n    c --> d\n' };

    it('replaces only the text between the markers', () => {
        const readme = 'before\n<!-- arch:start -->\nold\n<!-- arch:end -->\nafter\n';
        const out = updateReadme(readme, charts);
        expect(out.startsWith('before\n<!-- arch:start -->\n')).toBe(true);
        expect(out.endsWith('<!-- arch:end -->\nafter\n')).toBe(true);
        expect(out).not.toContain('old');
        expect(out).toContain('```mermaid\nflowchart LR\n    a --> b\n```');
        expect(updateReadme(out, charts)).toBe(out);
    });

    it('refuses a README without the markers', () => {
        expect(() => updateReadme('no markers here', charts)).toThrow(/arch:start/);
    });
});
