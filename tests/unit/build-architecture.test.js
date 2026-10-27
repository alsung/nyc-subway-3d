import { describe, it, expect } from 'vitest';
import { buildArchitecture, unknownHosts, renderHTML } from '../../scripts/build-architecture.mjs';

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
