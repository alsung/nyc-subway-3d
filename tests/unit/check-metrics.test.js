import { describe, it, expect } from 'vitest';
import { RULES, evaluate, authHeader, queryProm, retryDelay, describe as describeFinding } from '../../scripts/check-metrics.mjs';

const rule = RULES[0];

// A Prometheus instant-query response carrying the given samples.
const vector = (...samples) => ({
    status: 'success',
    data: { resultType: 'vector', result: samples },
});

const sample = (metric, value) => ({ metric, value: [1_700_000_000, String(value)] });

describe('evaluate', () => {
    it('fires when the expression returns samples', () => {
        const got = evaluate(rule, vector(sample({ group: 'ACE' }, 412)));
        expect(got.state).toBe('firing');
        expect(got.samples).toHaveLength(1);
    });

    it('is clear when the expression returns nothing', () => {
        // Each rule's threshold lives in its PromQL, so an empty vector means
        // the condition was not met.
        expect(evaluate(rule, vector()).state).toBe('ok');
    });

    it('reports a failed query as an error rather than as healthy', () => {
        // The failure mode these rules exist to catch is a system reporting
        // success while doing nothing. A broken query must not read as "clear".
        const got = evaluate(rule, { status: 'error', error: 'bad_data: parse error' });
        expect(got.state).toBe('error');
        expect(got.message).toContain('parse error');
    });

    it('treats a malformed or missing response as an error', () => {
        expect(evaluate(rule, null).state).toBe('error');
        expect(evaluate(rule, undefined).state).toBe('error');
        expect(evaluate(rule, 'nope').state).toBe('error');
        expect(evaluate(rule, { status: 'success', data: {} }).state).toBe('error');
        expect(evaluate(rule, { status: 'success', data: { result: 'not-an-array' } }).state).toBe('error');
    });
});

describe('the rule set', () => {
    it('gives every rule a name, an expression and a summary', () => {
        for (const r of RULES) {
            expect(r.name).toBeTruthy();
            expect(r.expr).toBeTruthy();
            expect(r.summary).toBeTruthy();
        }
        expect(new Set(RULES.map(r => r.name)).size).toBe(RULES.length);
    });

    it('covers absence, not only thresholds', () => {
        // Every threshold rule is silently satisfied by a metric that no longer
        // exists: `x > 180` over a missing x returns nothing, which reads as
        // healthy. Exactly one rule must guard that, and it must use absent().
        const guards = RULES.filter(r => r.expr.includes('absent('));
        expect(guards).toHaveLength(1);
        expect(guards[0].expr).toContain('feed_last_refresh_timestamp_seconds');
        // The rules over metrics from outside api/metrics.go need the same
        // guard, or a rename on Fly's side reads as a healthy disk.
        expect(guards[0].expr).toContain('process_resident_memory_bytes');
        expect(guards[0].expr).toContain('fly_instance_filesystem_blocks{');
    });

    it('queries only metrics the API actually exposes', () => {
        // Guards against a rule outliving a rename. These are the collectors in
        // api/metrics.go, plus process_resident_memory_bytes from the Go
        // client's default process collector, which /metrics also serves.
        const known = [
            'feed_last_refresh_timestamp_seconds',
            'feed_refresh_total',
            'alerts_labeled',
            'alerts_entities',
            'http_requests_total',
            'account_purge_last_success_timestamp_seconds',
            'timetable_services_active_today',
            'email_send_total',
            'process_resident_memory_bytes',
        ];
        // Exported by Fly for every machine, not by our code.
        const fromFly = [
            'fly_instance_filesystem_blocks',
            'fly_instance_filesystem_blocks_avail',
        ];
        const promFuncs = ['time', 'rate', 'absent', 'or', 'increase', 'sum', 'by', 'max_over_time'];
        for (const r of RULES) {
            const referenced = r.expr.match(/[a-z_][a-z0-9_]*(?=[\s{(]|$)/g) ?? [];
            const metrics = referenced.filter(t => t.includes('_') && !promFuncs.includes(t));
            for (const m of metrics) {
                expect([...known, ...fromFly], `${r.name} references unknown metric ${m}`).toContain(m);
            }
        }
    });
});

describe('describe', () => {
    it('renders each firing series with its labels and value', () => {
        const finding = evaluate(rule, vector(
            sample({ __name__: 'x', group: 'ACE' }, 412),
            sample({ group: 'JZ' }, 987),
        ));
        const text = describeFinding(finding, rule);

        expect(text).toContain(rule.summary);
        expect(text).toContain('group=ACE → 412');
        expect(text).toContain('group=JZ → 987');
        // __name__ is noise in an issue body.
        expect(text).not.toContain('__name__');
    });

    it('renders a query error without pretending it had samples', () => {
        const finding = evaluate(rule, { status: 'error', error: 'timeout' });
        expect(describeFinding(finding, rule)).toContain('query failed — timeout');
    });
});

// ── dashboard ────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';

const dashboard = JSON.parse(
    readFileSync(new URL('../../grafana/nyc-subway-api.json', import.meta.url), 'utf8'),
);

describe('the Grafana dashboard', () => {
    it('picks its data source at import time rather than hardcoding a UID', () => {
        // Fly's Prometheus UID is specific to an org, so a hardcoded one makes
        // the JSON unreviewable: anyone importing it gets empty panels.
        const variable = dashboard.templating.list.find(v => v.type === 'datasource');
        expect(variable).toBeTruthy();
        expect(variable.query).toBe('prometheus');

        for (const panel of dashboard.panels) {
            expect(panel.datasource.uid, `${panel.title} hardcodes a datasource`).toBe('${datasource}');
        }
    });

    it('gives every panel a title and at least one non-empty query', () => {
        // A panel with an empty expr renders as an empty graph and looks like
        // "no traffic" rather than "nobody wrote the query".
        for (const panel of dashboard.panels) {
            expect(panel.title).toBeTruthy();
            expect(panel.targets.length).toBeGreaterThan(0);
            for (const target of panel.targets) {
                expect(target.expr?.trim(), `${panel.title} has an empty expr`).toBeTruthy();
            }
        }
    });

    it('queries only metrics the API actually exposes', () => {
        const known = [
            'http_requests_total',
            'http_request_duration_seconds_bucket',
            'feed_last_refresh_timestamp_seconds',
            'feed_refresh_total',
            'alerts_labeled',
            'alerts_entities',
            'go_memstats_heap_inuse_bytes',
            'go_goroutines',
            'process_resident_memory_bytes',
            // from Fly, not api/metrics.go
            'fly_instance_filesystem_blocks',
            'fly_instance_filesystem_blocks_avail',
        ];
        const promFuncs = ['sum', 'rate', 'time', 'histogram_quantile', 'by', 'le', 'increase'];

        for (const panel of dashboard.panels) {
            for (const target of panel.targets) {
                const tokens = target.expr.match(/[a-z_][a-z0-9_]*(?=[\s{(,)]|$)/g) ?? [];
                for (const t of tokens.filter(t => t.includes('_') && !promFuncs.includes(t))) {
                    expect(known, `${panel.title} references unknown metric ${t}`).toContain(t);
                }
            }
        }
    });

    it('excludes the health check from the traffic panel', () => {
        // Fly checks /health every 15s. Left in, it was 64% of all requests and
        // made the panel a picture of Fly's monitoring rather than of traffic.
        const traffic = dashboard.panels.find(p => p.title === 'Request rate by route');
        expect(traffic.targets[0].expr).toContain('route!="/health"');
    });
});

describe('authHeader', () => {
    it('does not re-wrap a token that already carries its scheme', () => {
        // `fly tokens create` emits "FlyV1 fm2_...". Wrapping that again gives
        // "FlyV1 FlyV1 fm2_..." and a 401 indistinguishable from an expired
        // credential.
        expect(authHeader('FlyV1 fm2_abc')).toBe('FlyV1 fm2_abc');
        expect(authHeader('Bearer fo1_xyz')).toBe('Bearer fo1_xyz');
    });

    it('adds the scheme to a bare token', () => {
        expect(authHeader('fm2_abc')).toBe('FlyV1 fm2_abc');
    });

    it('tolerates surrounding whitespace from a piped secret', () => {
        expect(authHeader('  FlyV1 fm2_abc\n')).toBe('FlyV1 fm2_abc');
        expect(authHeader('\nfm2_abc  ')).toBe('FlyV1 fm2_abc');
    });

    it('does not throw on a missing token', () => {
        expect(authHeader(undefined)).toBe('FlyV1 ');
    });
});

// A fake fetch that answers with the given statuses in order, recording calls.
function fakeFetch(...answers) {
    const calls = [];
    const fetchImpl = async (url) => {
        calls.push(url);
        const a = answers[Math.min(calls.length - 1, answers.length - 1)];
        const { status, retryAfter } = typeof a === 'number' ? { status: a } : a;
        return {
            ok: status >= 200 && status < 300,
            status,
            headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? retryAfter ?? null : null) },
            json: async () => vector(),
        };
    };
    return { fetchImpl, calls };
}

describe('queryProm', () => {
    const run = (fetchImpl, waits) => queryProm('up', 'fm2_abc', { fetchImpl, sleep: async (ms) => waits.push(ms) });

    it('retries a 429 and returns the answer that follows', async () => {
        // The 2026-11-04 false alarm (#141): one rate-limited query failed the run.
        const { fetchImpl, calls } = fakeFetch(429, 200);
        const waits = [];
        const got = await run(fetchImpl, waits);
        expect(got.status).toBe('success');
        expect(calls).toHaveLength(2);
        expect(waits).toEqual([1000]);
    });

    it('retries a 5xx with backoff, then reports the error after three attempts', async () => {
        const { fetchImpl, calls } = fakeFetch(503);
        const waits = [];
        const got = await run(fetchImpl, waits);
        expect(calls).toHaveLength(3);
        expect(waits).toEqual([1000, 2000]);
        expect(evaluate(RULES[0], got)).toMatchObject({ state: 'error', message: 'HTTP 503 after 3 attempts' });
    });

    it('does not retry a 401 or 400', async () => {
        for (const status of [401, 400]) {
            const { fetchImpl, calls } = fakeFetch(status);
            const waits = [];
            const got = await run(fetchImpl, waits);
            expect(calls).toHaveLength(1);
            expect(waits).toEqual([]);
            expect(got.error).toBe(`HTTP ${status}`);
        }
    });

    it('waits as long as Retry-After asks', async () => {
        const { fetchImpl } = fakeFetch({ status: 429, retryAfter: '3' }, 200);
        const waits = [];
        await run(fetchImpl, waits);
        expect(waits).toEqual([3000]);
    });
});

describe('retryDelay', () => {
    it('backs off 1s then 2s without Retry-After', () => {
        expect(retryDelay(1, null)).toBe(1000);
        expect(retryDelay(2, null)).toBe(2000);
    });

    it('caps a large Retry-After so CI does not stall', () => {
        expect(retryDelay(1, '3600')).toBe(10_000);
    });

    it('ignores a Retry-After it cannot read as seconds', () => {
        // The header may also be an HTTP date; backoff is close enough there.
        expect(retryDelay(1, 'Wed, 04 Nov 2026 22:40:00 GMT')).toBe(1000);
        expect(retryDelay(2, '')).toBe(2000);
    });
});
