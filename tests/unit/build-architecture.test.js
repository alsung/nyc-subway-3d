import { describe, it, expect } from 'vitest';
import { buildArchitecture, unknownHosts, renderHTML, renderMermaid, updateReadme, itemKeys, stampHistory, nyDate } from '../../scripts/build-architecture.mjs';

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
        // PATCH is gated; DELETE stays open so riders can always remove their data.
        expect(route('PATCH', '/api/commutes/{id}').feature).toBe('saved_commutes');
        expect(route('DELETE', '/api/commutes/{id}').feature).toBeNull();
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
            .toEqual(['metricsMiddleware', 'corsMiddleware', 'rateLimitMiddleware', 'bodyLimitMiddleware', 'gzipMiddleware']);
        expect(arch.middleware[3].detail).toBe('Refuses request bodies over 64 KB with 413');
        expect(arch.middleware[2].detail).toBe('Per-IP token bucket: 10 req/s, burst 30, 429 when empty');
    });

    it('reads per-route rate limits, outermost first', () => {
        expect(arch.routeLimiters).toEqual([expect.objectContaining({ name: 'passwordLimit', perMinute: 10, burst: 5 })]);
        for (const path of ['register', 'login', 'resend-verification', 'forgot-password', 'reset-password']) {
            expect(route('POST', `/api/auth/${path}`).chain).toEqual(['passwordLimit']);
        }
        expect(route('POST', '/api/auth/change-password').chain).toEqual(['passwordLimit', 'requireAuth']);
        expect(route('POST', '/api/auth/refresh').chain).toEqual([]);
        // The limiter is a func literal inside the database block; its closing
        // brace must not end the block.
        expect(route('POST', '/api/auth/login').conditions).toEqual(['a.dbPool != nil']);
        expect(route('DELETE', '/api/commutes/{id}').conditions).toEqual(['a.dbPool != nil']);
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

describe('history', () => {
    // A copy whose history is rebuilt from scratch, so the tests do not depend
    // on what the committed JSON happens to carry.
    const base = () => structuredClone({ ...arch, history: undefined });

    it('keys items the way the page names its nodes', () => {
        const keys = itemKeys(arch);
        expect(keys.get('route:GET /health')).toBe('GET /health');
        expect(keys.has('table:users')).toBe(true);
        expect(keys.has('ext:mta-web')).toBe(true);
        expect(keys.has('edge:fe:src/ui/alerts-panel.js|ext:mta-web|call')).toBe(true);
        const fk = [...keys.keys()].find((k) => k.startsWith('fk:'));
        expect(keys.get(fk)).toMatch(/^foreign key \w+\.\w+ → \w+\.\w+$/);
    });

    it('tolerates a JSON version missing whole sections', () => {
        expect(() => itemKeys({ routes: [{ method: 'GET', path: '/x' }] })).not.toThrow();
    });

    it('treats the first version as the baseline, with nothing new', () => {
        const h = stampHistory(base(), null, '2026-11-01').history;
        expect(h).toEqual({ baseline: '2026-11-01', since: {}, removed: {} });
    });

    it('stamps an added route, its table edge and a new column with today', () => {
        const prev = stampHistory(base(), null, '2026-11-01');
        const next = base();
        next.routes.push({ method: 'GET', path: '/api/new', reads: ['users'], writes: [], caches: [], externals: [], callers: [] });
        next.schema.tables.find((t) => t.name === 'users').columns.push({ name: 'nickname', type: 'TEXT' });
        const h = stampHistory(next, prev, '2026-11-04').history;
        expect(h.since).toEqual({
            'route:GET /api/new': '2026-11-04',
            'edge:route:GET /api/new|table:users|read': '2026-11-04',
            'column:users.nickname': '2026-11-04',
        });
        expect(h.baseline).toBe('2026-11-01');
    });

    it('carries dates forward and is stable when nothing changed', () => {
        const prev = stampHistory(base(), null, '2026-11-01');
        prev.history.since['ext:mta-web'] = '2026-11-04';
        const again = stampHistory(base(), prev, '2026-12-25');
        expect(again.history).toEqual(prev.history);
    });

    it('moves a removed item to removed with its dates, and keeps it', () => {
        const prev = stampHistory(base(), null, '2026-11-01');
        prev.history.since['ext:mta-web'] = '2026-11-02';
        const next = base();
        next.externals = next.externals.filter((x) => x.id !== 'mta-web');
        const h = stampHistory(next, prev, '2026-11-05').history;
        expect(h.removed['ext:mta-web']).toEqual({ label: expect.stringContaining('www.mta.info'), since: '2026-11-02', removed: '2026-11-05' });
        expect(h.since['ext:mta-web']).toBeUndefined();
        // A later run with no change keeps the record.
        expect(stampHistory(next, { ...next, history: h }, '2026-11-09').history.removed['ext:mta-web']).toEqual(h.removed['ext:mta-web']);
    });

    it('records a baseline item that is removed with no first-seen date', () => {
        const prev = stampHistory(base(), null, '2026-11-01');
        const next = base();
        next.routes = next.routes.filter((r) => r.path !== '/health');
        expect(stampHistory(next, prev, '2026-11-05').history.removed['route:GET /health']).toEqual({ label: 'GET /health', since: null, removed: '2026-11-05' });
    });

    it('clears the removed record when an item comes back, and dates it anew', () => {
        const prev = stampHistory(base(), null, '2026-11-01');
        prev.history.removed['ext:mta-web'] = { label: 'x', since: null, removed: '2026-10-20' };
        const gone = structuredClone(prev);
        gone.externals = gone.externals.filter((x) => x.id !== 'mta-web');
        const h = stampHistory(base(), gone, '2026-11-06').history;
        expect(h.removed['ext:mta-web']).toBeUndefined();
        expect(h.since['ext:mta-web']).toBe('2026-11-06');
    });

    it('dates in New York, not UTC', () => {
        // 02:30 UTC on Nov 5 is still the evening of Nov 4 in New York.
        expect(nyDate(new Date('2026-11-05T02:30:00Z'))).toBe('2026-11-04');
    });
});
