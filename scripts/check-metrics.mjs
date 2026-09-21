// Alerting for the Go API, run on a schedule from CI.
//
// Fly's managed Grafana can draw dashboards but cannot alert — their docs say
// so outright — so the rules live here instead, queried against Fly's
// Prometheus HTTP API. That turns out to be the better place for them: a
// threshold in a repo is reviewable in a pull request, where the same number
// typed into a web form is not.
//
//   FLY_METRICS_TOKEN=... node scripts/check-metrics.mjs
//
// Exits non-zero when any rule fires or any query fails, which is what the
// workflow turns into a GitHub issue.
//
// The token is read-only and org-scoped, deliberately not the deploy token CI
// already holds — that one can destroy machines, and reading a counter should
// not require it. Create with:
//
//   fly tokens create readonly -o personal | gh secret set FLY_METRICS_TOKEN

const ORG = process.env.FLY_ORG ?? 'personal';
const PROM = `https://api.fly.io/prometheus/${ORG}/api/v1/query`;

// Each rule's expression is its own condition: Prometheus returns samples only
// when the rule is breached, so "did this query return anything" is the whole
// test. That is the same model Prometheus's own alerting uses, and it keeps the
// threshold visible in the expression rather than buried in JavaScript.
export const RULES = [
    {
        name: 'feed-stale',
        expr: 'time() - feed_last_refresh_timestamp_seconds > 180',
        summary: 'A GTFS-RT feed has not refreshed in over 3 minutes',
        detail:
            'Last-known-good caching means riders keep seeing data, so a dead ' +
            'upstream is invisible without this. Labelled per group: one stale ' +
            'feed among eight is exactly the case a single global gauge missed.',
    },
    {
        name: 'feed-failing',
        expr: 'rate(feed_refresh_total{result="failure"}[15m]) > 0',
        summary: 'A GTFS-RT feed is returning errors',
        detail: 'Fires before staleness does, since failures are retried every 30s.',
    },
    {
        name: 'alerts-unlabeled',
        expr: 'alerts_labeled / alerts_entities < 0.8',
        summary: "MTA's Mercury extension stopped parsing",
        detail:
            'Service alerts silently fall back to a generic label when this ' +
            'breaks. Nothing errors and nothing crashes; the alerts just stop ' +
            'saying which line they are about.',
    },
    {
        // The blind spot in every threshold above: an expression over a metric
        // that no longer exists returns nothing, which reads as healthy. This
        // is the rule that notices the metrics themselves went away — a renamed
        // collector, a failed deploy, a machine that never came back.
        name: 'metrics-absent',
        expr: 'absent(feed_last_refresh_timestamp_seconds) or absent(http_requests_total)',
        summary: 'The API is not reporting metrics at all',
        detail:
            'Every other rule here is a threshold, and a threshold over a ' +
            'missing metric is silently satisfied. This one fires on absence.',
    },
];

/**
 * Turns one Prometheus response into a verdict.
 *
 * Pure, so the interesting half of this script is testable without a network.
 *
 * @returns {{name: string, state: 'ok'|'firing'|'error', samples: object[], message?: string}}
 */
export function evaluate(rule, response) {
    if (!response || typeof response !== 'object') {
        return { name: rule.name, state: 'error', samples: [], message: 'no response' };
    }
    // A query that errored tells us nothing about health, and reporting it as
    // healthy would be the same silent-success failure these rules exist to
    // catch. It is its own state.
    if (response.status !== 'success') {
        return {
            name: rule.name,
            state: 'error',
            samples: [],
            message: response.error ?? `status=${response.status}`,
        };
    }

    const samples = response.data?.result;
    if (!Array.isArray(samples)) {
        return { name: rule.name, state: 'error', samples: [], message: 'malformed result' };
    }

    // No samples means the condition is not met. Correct for every rule here,
    // including metrics-absent: absent() returns a series when its argument is
    // missing, so an empty result there means the metric is present.
    return { name: rule.name, state: samples.length ? 'firing' : 'ok', samples };
}

/** One line per firing series, for the issue body. */
export function describe(finding, rule) {
    if (finding.state === 'error') return `${rule.name}: query failed — ${finding.message}`;

    const lines = finding.samples.map((s) => {
        const labels = Object.entries(s.metric ?? {})
            .filter(([k]) => k !== '__name__')
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        const value = s.value?.[1] ?? '?';
        return `  ${labels || '(no labels)'} → ${value}`;
    });
    return [`${rule.name}: ${rule.summary}`, ...lines].join('\n');
}

/**
 * The Authorization header for a Fly token.
 *
 * `fly tokens create` emits the token with its scheme already attached
 * ("FlyV1 fm2_..."), while `fly auth token` emits a bare macaroon that wants
 * "Bearer". Wrapping the first kind again yields "FlyV1 FlyV1 fm2_..." and a
 * 401 that looks exactly like an expired credential — which cost an hour here
 * before the token was examined rather than assumed.
 */
export function authHeader(token) {
    const t = String(token ?? '').trim();
    return /^(FlyV1|Bearer)\s/i.test(t) ? t : `FlyV1 ${t}`;
}

async function queryProm(expr, token) {
    const res = await fetch(`${PROM}?query=${encodeURIComponent(expr)}`, {
        headers: { Authorization: authHeader(token) },
    });
    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}` };
    return res.json();
}

async function main() {
    const token = process.env.FLY_METRICS_TOKEN;
    if (!token) {
        console.error('FLY_METRICS_TOKEN is not set');
        process.exit(2);
    }

    const problems = [];
    for (const rule of RULES) {
        const finding = evaluate(rule, await queryProm(rule.expr, token));
        const mark = { ok: 'ok     ', firing: 'FIRING ', error: 'ERROR  ' }[finding.state];
        console.log(`${mark} ${rule.name}  ${rule.expr}`);
        if (finding.state !== 'ok') {
            console.log(describe(finding, rule));
            console.log(`  ${rule.detail}`);
            problems.push(finding);
        }
    }

    if (problems.length) {
        console.error(`\n${problems.length} of ${RULES.length} rules need attention`);
        process.exit(1);
    }
    console.log(`\nall ${RULES.length} rules clear`);
}

// Only when run directly, so tests can import the pure parts.
if (import.meta.url === `file://${process.argv[1]}`) await main();
