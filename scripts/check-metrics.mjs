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
        name: 'purge-stale',
        expr: 'time() - account_purge_last_success_timestamp_seconds > 10800',
        summary: 'Account and token purge has not succeeded in 3 hours',
        detail:
            'The purge runs hourly and only logs on failure, so three missed ' +
            'runs means it has stopped. Deleted accounts past their 30 days ' +
            'and expired tokens stay in the database until it recovers.',
    },
    {
        name: 'email-failing',
        expr: 'increase(email_send_total{result="failure"}[30m]) > 0',
        summary: 'Verification or password reset emails are failing to send',
        detail:
            'A failed Resend call only logs, and the rider simply never gets ' +
            'the link. Labelled by kind, so it says which email is affected.',
    },
    {
        name: 'no-service-today',
        expr: 'timetable_services_active_today == 0',
        summary: 'The static timetable has no service today, so every trip plan is empty',
        detail:
            'The API loads MTA\'s static feed at startup, and MTA replaces it ' +
            'days before a new schedule begins. The planner bridges that gap, ' +
            'so this firing means a feed it could not bridge: expired, or ' +
            'missing calendar.txt. /health stays green throughout.',
    },
    {
        // /health stays green through all of these, and UptimeRobot only sees
        // /health and the homepage. With near-zero traffic, any 500 is a bug.
        name: 'http-5xx',
        expr: 'sum by (route) (increase(http_requests_total{status=~"5..",route!="/health"}[30m])) > 0',
        summary: 'A route returned server errors in the last 30 minutes',
        detail:
            'UptimeRobot only sees /health, which stays green while /api/plan ' +
            'or /api/auth/* fail. Labeled by route. A 503 from /api/plan in ' +
            'the seconds after a deploy is the timetable still loading; ' +
            'anything else is a bug: check `fly logs -a nyc-subway-api`.',
    },
    {
        // Fly's own metric for the database app's volume, not one of ours.
        name: 'db-disk',
        expr:
            '1 - fly_instance_filesystem_blocks_avail{app="nyc-subway-db",mount="/data"} ' +
            '/ fly_instance_filesystem_blocks{app="nyc-subway-db",mount="/data"} > 0.8',
        summary: 'The Postgres volume is over 80% full',
        detail:
            'When it fills, every write fails (sign-up, saved commutes, ' +
            'sessions) while /health stays green, because /health only pings ' +
            'the database. Run `fly volumes extend <id> -a nyc-subway-db -s <GB>` ' +
            'before it reaches 100%.',
    },
    {
        // Resident memory, not heap: the out-of-memory killer counts the whole
        // process, and resident memory runs about twice the Go heap here.
        name: 'api-memory',
        expr: 'max_over_time(process_resident_memory_bytes{app="nyc-subway-api"}[30m]) > 400e6',
        summary: 'The API used over 400 MB of its 512 MB in the last 30 minutes',
        detail:
            "An out-of-memory restart plus boot fits inside UptimeRobot's " +
            '5-minute gap, so nobody else sees it. max_over_time catches a ' +
            'spike between the 30-minute runs.',
    },
    {
        // The blind spot in every threshold above: an expression over a metric
        // that no longer exists returns nothing, which reads as healthy. This
        // is the rule that notices the metrics themselves went away — a renamed
        // collector, a failed deploy, a machine that never came back, or Fly
        // renaming the volume metrics db-disk reads.
        name: 'metrics-absent',
        expr:
            'absent(feed_last_refresh_timestamp_seconds) or absent(http_requests_total)' +
            ' or absent(process_resident_memory_bytes{app="nyc-subway-api"})' +
            ' or absent(fly_instance_filesystem_blocks{app="nyc-subway-db",mount="/data"})',
        summary: 'A metric the rules depend on is missing',
        detail:
            'Every other rule here is a threshold, and a threshold over a ' +
            'missing metric is silently satisfied. This one fires on absence. ' +
            'It also covers the Fly volume metrics the disk rule reads, so a ' +
            'renamed metric or a moved database app cannot pass silently.',
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
 * ("FlyV1 fm2_..."), while `fly auth token` emits it bare, and the bare form
 * also wants "FlyV1": sent as "Bearer" it gets a 401 (checked 2026-11-03).
 * Wrapping an already-prefixed token again yields "FlyV1 FlyV1 fm2_..." and a
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
