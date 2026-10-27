#!/usr/bin/env node
// Builds docs/architecture.json and docs/architecture.html from the source, so
// the architecture diagram follows the code instead of someone's memory of it.
//
// Derived from code: routes and their middleware (api/main.go newMux), what
// each handler reads and writes (SQL tables, in-memory caches, third-party
// calls, followed through the package's call graph), the schema (replaying
// api/migrations in order), background jobs, env vars, metrics, frontend
// callers (src/), build-time data sources (scripts/) and CI jobs.
//
// Declared by hand (DECLARED below): infrastructure the repo never names,
// such as the Fly Postgres app behind DATABASE_URL or the DNS registrar.
//
// This reads source with patterns, not a parser, so it relies on how the code
// is written today: routes registered in newMux, SQL as string literals,
// gofmt'd top-level declarations. tests/unit/build-architecture.test.js pins
// known answers so a pattern that stops matching fails loudly.
//
//   npm run arch                                  write both files
//   node scripts/build-architecture.mjs --check   exit 1 if either is out of
//                                                 date or the code calls a
//                                                 host not listed in EXTERNALS

import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

let ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const JSON_OUT = 'docs/architecture.json';
const HTML_OUT = 'docs/architecture.html';
const TEMPLATE = 'docs/architecture.template.html';
const SELF = 'scripts/build-architecture.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const list = (dir, re) => readdirSync(join(ROOT, dir)).filter((f) => re.test(f)).sort();
const lineOf = (text, idx) => text.slice(0, idx).split('\n').length;
// Drops // comments without cutting the // out of a "https://" string.
const stripComments = (s) => s.replace(/(^|[\s;{}])\/\/.*$/gm, '$1');

// ---------------------------------------------------------------- Go source

// Splits every non-test Go file into top-level declarations. Go's formatter
// starts each one at column 0, so a declaration runs until the next line that
// starts with func/var/const/type.
function goDecls() {
    const decls = new Map();
    for (const file of list('api', /^[a-z_]+\.go$/).filter((f) => !f.endsWith('_test.go'))) {
        const src = read(`api/${file}`);
        const starts = [...src.matchAll(/^(func|var|const|type) /gm)].map((m) => m.index);
        starts.forEach((start, i) => {
            const body = src.slice(start, starts[i + 1] ?? src.length);
            const line = lineOf(src, start);
            const names = [];
            let m;
            if ((m = body.match(/^func (?:\([^)]*\)\s*)?([A-Za-z_]\w*)/))) names.push(m[1]);
            else if ((m = body.match(/^(?:var|const|type) \(\n([\s\S]*?)\n\)/))) {
                // Each name in a grouped block gets only its own lines, so one
                // reference does not drag in its neighbors.
                const kind = body.slice(0, body.indexOf(' '));
                const specs = [...m[1].matchAll(/^\t([A-Za-z_]\w*)/gm)];
                specs.forEach((n, j) => {
                    const own = m[1].slice(n.index, specs[j + 1]?.index ?? m[1].length);
                    if (!decls.has(n[1])) decls.set(n[1], { name: n[1], kind, file, line: line + lineOf(m[1], n.index), body: own });
                });
                return;
            } else if ((m = body.match(/^(?:var|const|type) ([A-Za-z_]\w*)/))) names.push(m[1]);
            const kind = body.slice(0, body.indexOf(' '));
            for (const name of names) if (!decls.has(name) || kind === 'func') decls.set(name, { name, kind, file, line, body });
        });
    }
    return decls;
}

// Every declaration reachable from `name` through identifiers in its body.
// Types are skipped: a struct's field list says what exists, not what runs, and
// following the handler's receiver would pull in every method of app.
function reach(decls, name, seen = new Set()) {
    if (seen.has(name) || !decls.has(name) || decls.get(name).kind === 'type') return seen;
    seen.add(name);
    const body = stripComments(decls.get(name).body).replace(/^func \([^)]*\)/, 'func');
    for (const [id] of body.matchAll(/\b[A-Za-z_]\w*\b/g)) {
        if (id !== name && decls.has(id)) reach(decls, id, seen);
    }
    return seen;
}

// ---------------------------------------------------------------- schema

function schema() {
    const tables = new Map();
    const files = list('api/migrations', /\.up\.sql$/);
    for (const file of files) {
        const sql = read(`api/migrations/${file}`).replace(/--.*$/gm, '');
        for (const m of sql.matchAll(/CREATE TABLE (\w+) \(([\s\S]*?)\n\);/g)) {
            const columns = [];
            for (const raw of m[2].split('\n')) {
                const line = raw.trim().replace(/,$/, '');
                const c = line.match(/^(\w+)\s+([A-Z]+(?:\(\d+\))?)(.*)$/);
                if (!c) continue;
                const rest = c[3];
                const fk = rest.match(/REFERENCES (\w+)\((\w+)\)(?: ON DELETE (\w+))?/);
                columns.push({
                    name: c[1],
                    type: c[2],
                    pk: /PRIMARY KEY/.test(rest),
                    unique: /UNIQUE/.test(rest),
                    notNull: /NOT NULL|PRIMARY KEY/.test(rest),
                    default: rest.match(/DEFAULT ([^\s,]+(?:\(\))?)/)?.[1] ?? null,
                    fk: fk ? { table: fk[1], column: fk[2], onDelete: fk[3] ?? null } : null,
                });
            }
            tables.set(m[1], { name: m[1], migration: file, columns, indexes: [], seeds: [] });
        }
        for (const m of sql.matchAll(/CREATE (UNIQUE )?INDEX (\w+) ON (\w+)\s*\(([^)]+)\)(?:\s+WHERE ([^;]+))?;/g)) {
            tables.get(m[3])?.indexes.push({
                name: m[2], unique: !!m[1], columns: m[4].split(',').map((s) => s.trim()),
                where: m[5]?.trim() ?? null, migration: file,
            });
        }
        // An inline UNIQUE column gets Postgres's <table>_<column>_key name.
        for (const m of sql.matchAll(/ALTER TABLE (\w+) DROP CONSTRAINT (\w+);/g)) {
            const t = tables.get(m[1]);
            for (const c of t?.columns ?? []) {
                if (c.unique && `${m[1]}_${c.name}_key` === m[2]) c.unique = false;
            }
        }
        for (const m of sql.matchAll(/INSERT INTO (\w+) \(([^)]+)\) VALUES([\s\S]*?);/g)) {
            const t = tables.get(m[1]);
            for (const row of m[3].matchAll(/\('([^']+)'/g)) t?.seeds.push(row[1]);
        }
    }
    return { migrations: files.map((f) => f.replace('.up.sql', '')), tables: [...tables.values()] };
}

// ---------------------------------------------------------------- what code touches

// Package-level state the handlers read, and what fills it.
const CACHES = {
    feeds: { label: 'Real-time feed cache', ids: ['cachedFeeds', 'feedCache', 'cachedDepartures'] },
    alerts: { label: 'Service alerts cache', ids: ['cachedAlerts', 'alertsCache'] },
    timetable: { label: 'RAPTOR timetable', ids: ['currentTimetable', 'timetable'] },
    gtfsFiles: { label: 'Static GTFS files', ids: ['gtfsFiles'] },
    features: { label: 'Feature flag cache', ids: ['fc', 'featureAccessible'] },
};

// Third parties recognized by host, or by the function that is the only way
// in (Google's SDK hides its URL).
const EXTERNALS = [
    { id: 'mta-rt', host: 'mtagtfsfeeds/nyct', label: 'MTA GTFS-RT feeds', kind: 'data' },
    { id: 'mta-alerts', host: 'mtagtfsfeeds/camsys', label: 'MTA service alerts', kind: 'data' },
    { id: 'mta-static', host: 'rrgtfsfeeds.s3.amazonaws.com', label: 'MTA GTFS static (S3)', kind: 'data' },
    { id: 'resend', host: 'api.resend.com', label: 'Resend', kind: 'email' },
    { id: 'google', fn: 'verifyGoogleIDToken', host: 'accounts.google.com', label: 'Google Identity', kind: 'auth' },
    { id: 'stadia', host: 'tiles.stadiamaps.com', label: 'Stadia Maps', kind: 'tiles' },
    { id: 'nygov', host: 'data.ny.gov', label: 'data.ny.gov (Socrata)', kind: 'data' },
    { id: 'overpass', host: 'overpass-api.de', label: 'OpenStreetMap Overpass', kind: 'data' },
    { id: 'overpass', host: 'overpass.kumi.systems', label: 'OpenStreetMap Overpass', kind: 'data' },
    { id: 'fly-prom', host: 'api.fly.io/prometheus', label: 'Fly managed Prometheus', kind: 'monitoring' },
    { id: 'uptimerobot', host: 'stats.uptimerobot.com', label: 'UptimeRobot', kind: 'monitoring' },
    { id: 'gforms', host: 'forms.gle', label: 'Google Forms (feedback)', kind: 'other' },
];

// Libraries worth showing on the path a request takes.
const LIBS = {
    'JWT (HS256, 15 min)': /\b(signAccessToken|parseAccessToken)\(/,
    bcrypt: /\bbcrypt\./,
    'refresh token (SHA-256)': /\b(generateRefreshToken|hashToken)\(/,
    'RAPTOR planner': /\btt\.Plan\(/,
    'admin allowlist (ADMIN_EMAILS)': /\ba\.isAdmin\(/,
};

const externalFor = (url) => EXTERNALS.find((e) => url.includes(e.host));

// Hosts that are this project rather than a third party.
const OWN_HOSTS = [/^localhost$/, /^127\.0\.0\.1$/, /^localexpress\.nyc$/, /\.fly\.dev$/, /\.vercel\.app$/];

function touches(decls, root, tableNames) {
    const names = reach(decls, root);
    const out = { ping: false, libs: new Set(), reads: new Set(), writes: new Set(), caches: new Set(), externals: new Set(), env: new Set(), metrics: new Set(), funcs: [] };
    for (const n of names) {
        const d = decls.get(n);
        if (n !== root) out.funcs.push(`${n} (${d.file}:${d.line})`);
        const body = stripComments(d.body);
        for (const [, verb, t] of body.matchAll(/\b(FROM|JOIN|INTO|UPDATE|DELETE FROM)\s+(\w+)/g)) {
            if (!tableNames.has(t)) continue;
            (verb === 'FROM' || verb === 'JOIN') && !/DELETE FROM\s+$/.test(body.slice(0, body.indexOf(`${verb} ${t}`)))
                ? out.reads.add(t) : out.writes.add(t);
        }
        // Table names held in a list and spliced into the statement.
        if (/\b(?:FROM|INTO|UPDATE) `\s*\+\s*\w+/.test(body)) {
            for (const lit of body.matchAll(/\[\]string\{([^}]*)\}/g)) {
                for (const [, t] of lit[1].matchAll(/"(\w+)"/g)) if (tableNames.has(t)) out.writes.add(t);
            }
        }
        if (/\bpingDB\(/.test(body)) out.ping = true;
        for (const [lib, re] of Object.entries(LIBS)) if (re.test(body)) out.libs.add(lib);
        for (const [key, c] of Object.entries(CACHES)) {
            if (c.ids.some((id) => new RegExp(`\\b${id}\\b`).test(body))) out.caches.add(key);
        }
        for (const [url] of body.matchAll(/https?:\/\/[^\s"`]+/g)) {
            const e = externalFor(url);
            if (e) out.externals.add(e.id);
        }
        for (const e of EXTERNALS) if (e.fn === n) out.externals.add(e.id);
        for (const [, v] of body.matchAll(/os\.Getenv\("(\w+)"\)/g)) out.env.add(v);
        for (const [, m] of body.matchAll(/\b(metric[A-Z]\w*)\./g)) out.metrics.add(m);
    }
    // A DELETE FROM matched as FROM above: keep writes authoritative.
    for (const t of out.writes) out.reads.delete(t);
    const toArr = (s) => [...s].sort();
    return {
        reads: toArr(out.reads), writes: toArr(out.writes), caches: toArr(out.caches),
        externals: toArr(out.externals), env: toArr(out.env), metrics: toArr(out.metrics),
        calls: out.funcs.sort(), pingsDatabase: out.ping, libs: toArr(out.libs),
    };
}

// ---------------------------------------------------------------- routes

function routes(decls) {
    const mux = decls.get('newMux');
    const body = mux.body;
    const out = [];
    const regs = [...body.matchAll(/(?:mux|root)\.Handle(?:Func)?\("([A-Z]+) ([^"]+)",/g)];
    for (const m of regs) {
        // The registration statement, joined across lines.
        const stmtStart = m.index;
        let depth = 0, end = stmtStart;
        for (let i = body.indexOf('(', stmtStart); i < body.length; i++) {
            if (body[i] === '(') depth++;
            if (body[i] === ')' && --depth === 0) { end = i + 1; break; }
        }
        const stmt = body.slice(stmtStart, end).replace(/\s+/g, ' ');
        const line = mux.line + lineOf(body, stmtStart) - 1;
        const conds = conditionsAt(body, stmtStart);
        const handler = stmt.match(/(?:a\.)?(handle\w+)/)?.[1] ?? (stmt.includes('promhttp') ? 'promhttp.Handler' : null);
        const chain = [];
        if (/requireAuth\(/.test(stmt)) chain.push('requireAuth');
        if (/optionalAuth\(/.test(stmt)) chain.push('optionalAuth');
        const feature = stmt.match(/requireFeature\("(\w+)"\)/)?.[1] ?? null;
        if (feature) chain.push(`requireFeature(${feature})`);
        out.push({ method: m[1], path: m[2], handler, mux: stmt.startsWith('root') ? 'root' : 'api', chain, feature, conditions: conds, line });
    }
    // The same method+path registered in both arms of an if/else is one route
    // with two shapes; keep the database-backed one and note the other.
    const merged = new Map();
    for (const r of out) {
        const key = `${r.method} ${r.path}`;
        const prev = merged.get(key);
        if (!prev) { merged.set(key, { ...r, variants: [] }); continue; }
        const [keep, alt] = r.conditions.some((c) => !c.startsWith('!')) ? [r, prev] : [prev, r];
        merged.set(key, { ...keep, variants: [{ conditions: alt.conditions, chain: alt.chain }] });
    }
    return [...merged.values()];
}

// The if-blocks a registration sits inside: dbPool and googleClientID decide
// whether a route exists at all.
function conditionsAt(body, idx) {
    const before = body.slice(0, idx).split('\n');
    const stack = [];
    for (const line of before) {
        const cond = line.match(/^\s*if (.+) \{$/);
        if (cond) { stack.push(cond[1].trim()); continue; }
        if (/^\s*\} else \{$/.test(line)) { stack.push(`!(${stack.pop()})`); continue; }
        if (/^\s*\}\s*$/.test(line)) stack.pop();
    }
    return stack.filter((c) => !/err != nil/.test(c));
}

function middleware(decls) {
    const mux = decls.get('newMux').body;
    const wrap = mux.match(/root\.Handle\("\/", (.+)\)\n/)?.[1] ?? '';
    const order = [...wrap.matchAll(/(\w+Middleware)/g)].map((m) => m[1]);
    const rl = mux.match(/newIPRateLimiter\(([\d.]+), (\d+)\)/);
    const cors = decls.get('corsMiddleware')?.body ?? '';
    const origins = [
        ...[...cors.matchAll(/origin == "([^"]+)"/g)].map((m) => m[1]),
        ...[...cors.matchAll(/HasPrefix\(origin, "([^"]+)"\)/g)].map((m) => `${m[1]}*`),
        ...[...cors.matchAll(/HasSuffix\(origin, "([^"]+)"\)/g)].map((m) => `*${m[1]}`),
    ];
    const describe = {
        metricsMiddleware: 'Counts and times every request by route pattern',
        rateLimitMiddleware: rl ? `Per-IP token bucket: ${rl[1]} req/s, burst ${rl[2]}, 429 when empty` : 'Per-IP rate limit',
        corsMiddleware: `Allows ${origins.join(', ')}`,
        gzipMiddleware: 'Gzips responses when the client accepts it',
    };
    return order.map((name) => ({ name, detail: describe[name] ?? '', file: decls.get(name)?.file, line: decls.get(name)?.line }));
}

// ---------------------------------------------------------------- background jobs

function jobs(decls, tableNames) {
    const main = decls.get('main').body;
    const out = [];
    for (const m of main.matchAll(/go (start\w+)\(/g)) {
        const d = decls.get(m[1]);
        const interval = (() => {
            const t = d.body.match(/NewTicker\(([^)]+)\)/)?.[1];
            if (!t) return null;
            const c = decls.get(t.trim());
            const raw = (c ? c.body.match(/=\s*(.+)/)?.[1] : t).trim();
            const n = raw.match(/^(\d+)\s*\*\s*time\.(Second|Minute|Hour)$/);
            if (n) return `${n[1]}${n[2][0].toLowerCase()}`;
            const u = raw.match(/^time\.(Second|Minute|Hour)$/);
            return u ? `1${u[1][0].toLowerCase()}` : raw;
        })();
        const gated = new RegExp(`if a\\.dbPool != nil \\{[^}]*go ${m[1]}\\(`).test(main);
        out.push({ name: m[1], file: d.file, line: d.line, interval, needsDatabase: gated, ...touches(decls, m[1], tableNames) });
    }
    // Boot-time work that main runs before serving.
    for (const name of ['loadGTFSStatic', 'runMigrations', 'loadFeatures']) {
        const d = decls.get(name);
        if (d && main.includes(`${name}(`)) out.push({ name, file: d.file, line: d.line, interval: 'at boot', needsDatabase: name !== 'loadGTFSStatic', ...touches(decls, name, tableNames) });
    }
    return out;
}

// ---------------------------------------------------------------- frontend

function walk(dir) {
    return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(`${dir}/${e.name}`) : /\.(js|mjs)$/.test(e.name) ? [`${dir}/${e.name}`] : []);
}

function frontend(routeList) {
    const callers = new Map();
    const statics = new Map();
    const externals = new Map();
    const files = [...walk('src'), 'index.html'];
    for (const file of files) {
        const src = read(file);
        for (const m of src.matchAll(/\/api\/[a-z-]+(?:\/[a-z-]+)?(?:\/\$\{[^}]+\})?/g)) {
            const lineText = src.slice(src.lastIndexOf('\n', m.index) + 1, m.index);
            if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue;
            const path = m[0].replace(/\$\{[^}]+\}/, '{}');
            const ctx = src.slice(m.index, m.index + 400);
            const method = ctx.match(/method:\s*'([A-Z]+)'/)?.[1] ?? 'GET';
            const route = routeList.find((r) => r.method === method && r.path.replace(/\{[^}]+\}/, '{}') === path);
            const key = route ? `${route.method} ${route.path}` : `${method} ${path}`;
            if (!callers.has(key)) callers.set(key, []);
            callers.get(key).push(`${file}:${lineOf(src, m.index)}`);
        }
        for (const m of src.matchAll(/fetch\(\s*['`]\/([a-z-]+\.json|gtfs)/g)) {
            statics.set(`/${m[1]}`, [...(statics.get(`/${m[1]}`) ?? []), `${file}:${lineOf(src, m.index)}`]);
        }
        for (const [url] of src.matchAll(/https?:\/\/[^\s"'`?)]+/g)) {
            const e = externalFor(url);
            if (e) externals.set(e.id, [...new Set([...(externals.get(e.id) ?? []), file])]);
        }
    }
    const pkg = JSON.parse(read('package.json'));
    if (pkg.dependencies?.['@vercel/analytics']) externals.set('vercel-analytics', ['src/main.js']);
    const modules = walk('src').map((f) => f.replace(/^src\//, ''));
    return { callers: Object.fromEntries(callers), statics: Object.fromEntries(statics), externals: Object.fromEntries(externals), modules, dependencies: pkg.dependencies };
}

// ---------------------------------------------------------------- build + CI

function buildPipeline() {
    const out = [];
    for (const file of list('scripts', /\.(mjs|sh)$/)) {
        if (`scripts/${file}` === SELF) continue;
        const src = read(`scripts/${file}`);
        const ext = [...new Set([...src.matchAll(/https?:\/\/[^\s"'`?)\\]+/g)].map((m) => externalFor(m[0])?.id).filter(Boolean))];
        const outputs = [...new Set([...src.matchAll(/public\/([\w.-]*\w)/g)].map((m) => `public/${m[1]}`))];
        out.push({ file: `scripts/${file}`, externals: ext, outputs });
    }
    return out;
}

function workflows() {
    return list('.github/workflows', /\.ya?ml$/).map((file) => {
        const y = read(`.github/workflows/${file}`);
        const name = y.match(/^name: (.+)$/m)?.[1];
        const triggers = [];
        if (/^\s+push:/m.test(y)) triggers.push('push');
        if (/^\s+pull_request:/m.test(y)) triggers.push('pull request');
        const cron = y.match(/cron: "([^"]+)"/)?.[1];
        if (cron) triggers.push(`cron ${cron}`);
        const jobs = [...y.matchAll(/^  ([\w-]+):\n    name: (.+)$/gm)].map((m) => {
            const block = y.slice(m.index).split(/\n  [\w-]+:\n    name:/)[0];
            return {
                id: m[1], name: m[2],
                needs: block.match(/needs: \[([^\]]+)\]/)?.[1].split(',').map((s) => s.trim()) ?? [],
                services: [...block.matchAll(/image: (\S+)/g)].map((s) => s[1]),
                secrets: [...new Set([...block.matchAll(/secrets\.(\w+)/g)].map((s) => s[1]))],
                onlyMaster: /if: github\.ref == 'refs\/heads\/master'/.test(block),
            };
        });
        return { file: `.github/workflows/${file}`, name, triggers, jobs };
    });
}

function flyConfig() {
    const t = read('api/fly.toml');
    const get = (k) => t.match(new RegExp(`^\\s*${k} = '?"?([^'"\\n]+)`, 'm'))?.[1];
    return {
        app: get('app'), region: get('primary_region'), memory: get('memory'),
        cpuKind: get('cpu_kind'), cpus: get('cpus'), port: get('internal_port'),
        healthCheck: get('path'), healthInterval: get('interval'),
        metricsPath: t.match(/\[metrics\][\s\S]*?path = "([^"]+)"/)?.[1], minMachines: get('min_machines_running'),
        goVersion: get('GO_VERSION'),
    };
}

function vercelConfig() {
    const v = JSON.parse(read('vercel.json'));
    return {
        buildCommand: v.buildCommand, outputDirectory: v.outputDirectory,
        redirects: (v.redirects ?? []).map((r) => ({ source: r.source, destination: r.destination, external: externalFor(r.destination)?.id ?? null })),
        rewrites: (v.rewrites ?? []).map((r) => `${r.source} → ${r.destination}`),
        headers: (v.headers ?? []).map((h) => `${h.source}: ${h.headers.map((x) => `${x.key}: ${x.value}`).join('; ')}`),
    };
}

function metricsList() {
    const src = ['metrics.go', 'ratelimit.go'].map((f) => [f, read(`api/${f}`)]);
    const out = [];
    for (const [file, s] of src) {
        for (const m of s.matchAll(/(metric\w+) = promauto\.New(\w+)\(prometheus\.\w+Opts\{\s*Name:\s*"(\w+)",\s*Help:\s*"([^"]+)"/g)) {
            const labels = s.slice(m.index, m.index + 400).match(/\}, \[\]string\{([^}]*)\}/)?.[1];
            out.push({ var: m[1], type: m[2].replace('Vec', ''), name: m[3], help: m[4], labels: labels ? labels.split(',').map((x) => x.trim().replace(/"/g, '')) : [], file });
        }
    }
    return out;
}

function openapiPaths() {
    const y = read('api/openapi.yml');
    const out = new Set();
    let cur = null;
    for (const line of y.split('\n')) {
        const p = line.match(/^  (\/\S*):\s*$/);
        if (p) { cur = p[1]; continue; }
        const m = line.match(/^    (get|post|put|patch|delete):/);
        if (m && cur) out.add(`${m[1].toUpperCase()} ${cur}`);
    }
    return out;
}

// Infrastructure no file in the repo names. Edit by hand when it changes.
const DECLARED = {
    healthMonitors: ['UptimeRobot HTTP monitor'],
    machines: [
        { id: 'fly-db', label: 'nyc-subway-db', provider: 'Fly.io Postgres', detail: 'Fly Postgres app in ewr on a 1 GB volume, with volume snapshots kept 5 days. The API reaches it through the DATABASE_URL secret.' },
    ],
    services: [
        { id: 'vercel', label: 'Vercel', kind: 'hosting', detail: 'Builds every push with vercel.json buildCommand, serves dist/ and the SPA rewrite. Production alias localexpress.nyc.' },
        { id: 'vercel-analytics', label: 'Vercel Web Analytics', kind: 'monitoring', detail: 'Page views from @vercel/analytics inject().' },
        { id: 'namecheap', label: 'Namecheap DNS', kind: 'dns', detail: 'Registrar and DNS for localexpress.nyc (expires 2027-09-02). The send. subdomain holds the Resend sending records.' },
        { id: 'fly-grafana', label: 'Fly managed Grafana', kind: 'monitoring', detail: 'Dashboard grafana/nyc-subway-api.json over the same Prometheus. No alerting; rules run in CI.' },
        { id: 'github', label: 'GitHub Actions', kind: 'ci', detail: 'Tests, Fly deploy, scheduled metrics and feed checks; opens issues when a check fails.' },
    ],
};

// ---------------------------------------------------------------- hosts

// Every host the code reaches that is neither ours nor in EXTERNALS. Comments
// are skipped: a documentation link is not a dependency.
export function unknownHosts(root = ROOT) {
    ROOT = root;
    const files = [
        ...list('api', /^[a-z_]+\.go$/).filter((f) => !f.endsWith('_test.go')).map((f) => `api/${f}`),
        ...walk('src'), 'index.html', 'vercel.json',
        ...list('scripts', /\.(mjs|sh)$/).map((f) => `scripts/${f}`).filter((f) => f !== SELF),
        ...list('.github/workflows', /\.ya?ml$/).map((f) => `.github/workflows/${f}`),
    ];
    const found = new Map();
    for (const file of files) {
        const lines = read(file).split('\n');
        lines.forEach((text, i) => {
            if (/^\s*(\/\/|\*|\/\*|#)/.test(text)) return;
            for (const [url] of stripComments(text).matchAll(/https?:\/\/[^\s"'`?)\\]+/g)) {
                const host = url.replace(/^https?:\/\//, '').split(/[/:]/)[0];
                // Placeholders such as "https://…vercel.app" in usage text.
                if (!/^[a-z0-9.-]+$/i.test(host) || OWN_HOSTS.some((re) => re.test(host)) || externalFor(url)) continue;
                if (!found.has(host)) found.set(host, `${file}:${i + 1}`);
            }
        });
    }
    return [...found].map(([host, at]) => ({ host, at }));
}

// ---------------------------------------------------------------- assemble

export function buildArchitecture(root = ROOT) {
    ROOT = root;
    const decls = goDecls();
    const schemaData = schema();
    const tableNames = new Set(schemaData.tables.map((t) => t.name));
    const routeList = routes(decls).map((r) => {
        const t = r.handler && decls.has(r.handler)
            ? touches(decls, r.handler, tableNames)
            : { reads: [], writes: [], caches: [], externals: [], env: [], metrics: [], calls: [], pingsDatabase: false, libs: [] };
        if (r.feature) t.caches = [...new Set([...t.caches, 'features'])].sort();
        const h = decls.get(r.handler);
        const access = r.chain.includes('requireAuth') ? 'auth' : r.chain.includes('optionalAuth') ? 'optional' : r.mux === 'root' ? 'internal' : 'public';
        return { ...r, access, file: h?.file ?? 'main.go', handlerLine: h?.line ?? r.line, ...t };
    });
    const fe = frontend(routeList);
    const spec = openapiPaths();
    const fly = flyConfig();
    for (const r of routeList) {
        r.callers = fe.callers[`${r.method} ${r.path}`] ?? [];
        r.machineCallers = [];
        if (r.method === 'GET' && r.path === fly.healthCheck) r.machineCallers.push(`Fly health check, every ${fly.healthInterval} (api/fly.toml)`, ...DECLARED.healthMonitors);
        if (r.method === 'GET' && r.path === fly.metricsPath) r.machineCallers.push('Fly managed Prometheus scrape (api/fly.toml [metrics])');
        r.inOpenAPI = spec.has(`${r.method} ${r.path}`);
    }
    const routeKeys = new Set(routeList.map((r) => `${r.method} ${r.path}`));

    return {
        generatedFrom: SELF,
        fly,
        vercel: vercelConfig(),
        middleware: middleware(decls),
        routes: routeList,
        jobs: jobs(decls, tableNames),
        caches: Object.entries(CACHES).map(([id, c]) => ({ id, label: c.label })),
        schema: schemaData,
        externals: [...new Map(EXTERNALS.map((e) => [e.id, { id: e.id, label: e.label, kind: e.kind, host: e.host }])).values()],
        frontend: { ...fe, callers: undefined },
        build: buildPipeline(),
        workflows: workflows(),
        env: {
            api: [...new Set([...decls.values()].flatMap((d) => [...d.body.matchAll(/os\.Getenv\("(\w+)"\)/g)].map((m) => m[1])))].sort(),
            web: [...new Set(read('.env.example').match(/VITE_\w+/g) ?? [])].sort(),
        },
        metrics: metricsList(),
        declared: DECLARED,
        drift: {
            notInOpenAPI: routeList.filter((r) => !r.inOpenAPI && r.mux !== 'root').map((r) => `${r.method} ${r.path}`),
            openAPIOnly: [...spec].filter((k) => !routeKeys.has(k)),
            frontendCallsWithoutRoute: Object.keys(fe.callers).filter((k) => !routeKeys.has(k)),
            noFrontendCaller: routeList.filter((r) => r.callers.length === 0 && r.machineCallers.length === 0).map((r) => `${r.method} ${r.path}`),
        },
    };
}

// The template is an Artifact-style page body; a standalone file needs the
// document shell around it. "<" is escaped so no string in the data can close
// the script tag it is embedded in.
export function renderHTML(json, template) {
    const data = json.trim().replace(/</g, '\\u003c');
    return '<!doctype html>\n<html lang="en">\n<meta charset="utf-8">\n'
        + '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
        + template.replace('__ARCH_DATA__', () => data) + '</html>\n';
}

function main() {
    const data = buildArchitecture();
    const json = JSON.stringify(data, null, 2) + '\n';
    const html = renderHTML(json, read(TEMPLATE));
    const summary = `${data.routes.length} routes, ${data.schema.tables.length} tables, ${data.jobs.length} jobs`;

    if (process.argv.includes('--check')) {
        const problems = [];
        for (const [path, want] of [[JSON_OUT, json], [HTML_OUT, html]]) {
            const have = existsSync(join(ROOT, path)) ? read(path) : '';
            if (have !== want) problems.push(`${path} is out of date. Run: npm run arch`);
        }
        for (const { host, at } of unknownHosts()) {
            problems.push(`${at} calls ${host}, which is not a known third party. Add it to EXTERNALS in ${SELF}.`);
        }
        if (problems.length) {
            for (const p of problems) console.error(p);
            process.exit(1);
        }
        console.log(`architecture is current: ${summary}`);
        return;
    }
    writeFileSync(join(ROOT, JSON_OUT), json);
    writeFileSync(join(ROOT, HTML_OUT), html);
    console.log(`wrote ${JSON_OUT} and ${HTML_OUT}: ${summary}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
