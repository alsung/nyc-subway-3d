#!/usr/bin/env node
// Builds docs/architecture.json, docs/architecture.html and the Mermaid diagram
// in README.md from the source, so the architecture diagram follows the code
// instead of someone's memory of it.
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
//   npm run arch                                  write all three
//   node scripts/build-architecture.mjs --check   exit 1 if any is out of
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

// ---------------------------------------------------------------- README diagram

// GitHub renders Mermaid in Markdown but runs no scripts, so the README gets
// service-level flowcharts instead of the HTML page: routes grouped by their
// first path segment, with tables, caches and third parties as nodes. Requests
// and background jobs are separate charts because their edges cross each
// other. The full per-route detail stays in the HTML page.
const mermaidId = (prefix, name) => `${prefix}_${name.replace(/[^A-Za-z0-9]/g, '_')}`;
const mermaidText = (s) => s.replace(/"/g, '#quot;').replace(/</g, '#lt;').replace(/>/g, '#gt;');
const routeGroup = (path) => path.match(/^\/api\/([^/]+)/)?.[1] ?? path.slice(1);
const accessLabel = (reads, writes, t) => [reads.has(t) && 'reads', writes.has(t) && 'writes'].filter(Boolean).join(', ');

// Collects nodes per subgraph and edges, then prints subgraphs in the order
// they were declared, which is the left-to-right order Mermaid lays out.
function chart() {
    const groups = new Map();
    const edges = new Set();
    return {
        node(group, title, line) {
            if (!groups.has(group)) groups.set(group, { title, nodes: new Set() });
            groups.get(group).nodes.add(line);
        },
        edge(from, to, label = '', dotted = false) {
            edges.add(`    ${from} ${dotted ? '-.->' : '-->'}${label ? `|${label}|` : ''} ${to}`);
        },
        render() {
            const out = ['flowchart LR'];
            for (const [id, g] of groups) out.push(`    subgraph ${id}["${g.title}"]`, ...[...g.nodes].map((n) => `        ${n}`), '    end');
            return [...out, ...edges].join('\n') + '\n';
        },
    };
}

export function renderMermaid(arch) {
    const labelOf = (id) => arch.externals.find((e) => e.id === id)?.label
        ?? arch.declared.services.find((s) => s.id === id)?.label ?? id;
    const db = arch.declared.machines.find((m) => m.id === 'fly-db');
    // Mermaid clips subgraph titles wider than their contents, so these stay
    // short; the README paragraph above the charts names the Fly apps.
    const apiTitle = `API · ${arch.fly.app}`;
    const pgTitle = `Postgres · ${db?.label ?? 'database'}`;
    const tableNode = (name) => {
        const pk = arch.schema.tables.find((t) => t.name === name).columns.filter((c) => c.pk).map((c) => c.name).join(', ');
        return `${mermaidId('t', name)}[("${name}<br/>PK ${pk}")]`;
    };
    const cacheNode = (id) => `${mermaidId('c', id)}(["${mermaidText(arch.caches.find((c) => c.id === id).label)}"])`;
    const externalNode = (id) => `${mermaidId('x', id)}["${mermaidText(labelOf(id))}"]`;

    // Requests: callers on the left, route groups, then what they touch.
    const req = chart();
    req.node('web', 'Browser · Vercel', `fe["Web app (Vite, MapLibre)<br/>${arch.frontend.modules.length} modules"]`);
    const groups = new Map();
    for (const r of arch.routes) {
        const g = routeGroup(r.path);
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(r);
    }
    const monitors = {
        'fly-health': [/Fly health check/, `Fly health check<br/>every ${arch.fly.healthInterval}`, 'checks'],
        uptimerobot: [/UptimeRobot/, mermaidText(labelOf('uptimerobot')), 'checks'],
        'fly-prom': [/Prometheus/, mermaidText(labelOf('fly-prom')), 'scrapes'],
    };
    for (const [g, rs] of groups) {
        const id = mermaidId('r', g);
        const label = rs.length === 1
            ? mermaidText(`${rs[0].method} ${rs[0].path}`)
            : `${mermaidText(`/api/${g}/*`)}<br/>${rs.length} routes`;
        req.node('api', apiTitle, `${id}["${label}"]`);
        if (rs.some((r) => r.callers.length)) req.edge('fe', id);
        for (const caller of new Set(rs.flatMap((r) => r.machineCallers))) {
            const [x, [, text, verb]] = Object.entries(monitors).find(([, [re]]) => re.test(caller)) ?? [null, []];
            if (!x) continue;
            req.node('mon', 'Monitoring', `${mermaidId('x', x)}["${text}"]`);
            req.edge(mermaidId('x', x), id, verb);
        }
    }
    for (const [g, rs] of groups) {
        const reads = new Set(rs.flatMap((r) => r.reads));
        const writes = new Set(rs.flatMap((r) => r.writes));
        for (const t of [...new Set([...reads, ...writes])].sort()) {
            req.node('pg', pgTitle, tableNode(t));
            req.edge(mermaidId('r', g), mermaidId('t', t), accessLabel(reads, writes, t));
        }
        for (const c of [...new Set(rs.flatMap((r) => r.caches))].sort()) {
            req.node('mem', 'In-memory caches (API)', cacheNode(c));
            req.edge(mermaidId('r', g), mermaidId('c', c), '', true);
        }
        for (const x of [...new Set(rs.flatMap((r) => r.externals))].sort()) {
            req.node('ext', 'Third-party services', externalNode(x));
            req.edge(mermaidId('r', g), mermaidId('x', x));
        }
    }
    for (const x of Object.keys(arch.frontend.externals).sort()) {
        req.node('ext', 'Third-party services', externalNode(x));
        req.edge('fe', mermaidId('x', x));
    }
    for (const t of arch.schema.tables) {
        for (const c of t.columns.filter((col) => col.fk)) {
            req.node('pg', pgTitle, tableNode(t.name));
            req.node('pg', pgTitle, tableNode(c.fk.table));
            req.edge(mermaidId('t', t.name), mermaidId('t', c.fk.table), c.name, true);
        }
    }

    // Background jobs: what fills each cache, and what runs on a timer.
    const bg = chart();
    for (const j of arch.jobs) {
        const id = mermaidId('j', j.name);
        bg.node('jobs', 'Background jobs', `${id}[["${j.name}<br/>${j.interval === 'at boot' ? 'at boot' : `every ${j.interval}`}"]]`);
        for (const x of j.externals) {
            bg.node('ext', 'Third-party services', externalNode(x));
            bg.edge(mermaidId('x', x), id, 'fetches');
        }
    }
    for (const j of arch.jobs) {
        const id = mermaidId('j', j.name);
        for (const c of j.caches) {
            bg.node('mem', 'In-memory caches (API)', cacheNode(c));
            bg.edge(id, mermaidId('c', c), 'fills');
        }
        const reads = new Set(j.reads);
        const writes = new Set(j.writes);
        for (const t of [...new Set([...reads, ...writes])].sort()) {
            bg.node('pg', pgTitle, tableNode(t));
            bg.edge(id, mermaidId('t', t), accessLabel(reads, writes, t));
        }
    }
    return { requests: req.render(), jobs: bg.render() };
}

const README = 'README.md';
const README_START = '<!-- arch:start -->';
const README_END = '<!-- arch:end -->';

// Replaces only the text between the markers; the rest of the README is
// written by hand.
export function updateReadme(readme, { requests, jobs }) {
    const start = readme.indexOf(README_START);
    const end = readme.indexOf(README_END);
    if (start === -1 || end < start) throw new Error(`${README} needs ${README_START} and ${README_END} around the generated diagram`);
    const block = `${README_START}\n<!-- Generated by npm run arch from the code. Edits here are overwritten. -->\n`
        + `**Requests**\n\n\`\`\`mermaid\n${requests}\`\`\`\n\n`
        + `**Background jobs**\n\n\`\`\`mermaid\n${jobs}\`\`\`\n`;
    return readme.slice(0, start) + block + readme.slice(end);
}

function main() {
    const data = buildArchitecture();
    const json = JSON.stringify(data, null, 2) + '\n';
    const html = renderHTML(json, read(TEMPLATE));
    const readme = updateReadme(read(README), renderMermaid(data));
    const summary = `${data.routes.length} routes, ${data.schema.tables.length} tables, ${data.jobs.length} jobs`;

    if (process.argv.includes('--check')) {
        const problems = [];
        for (const [path, want] of [[JSON_OUT, json], [HTML_OUT, html], [README, readme]]) {
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
    writeFileSync(join(ROOT, README), readme);
    console.log(`wrote ${JSON_OUT}, ${HTML_OUT} and the ${README} diagram: ${summary}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
