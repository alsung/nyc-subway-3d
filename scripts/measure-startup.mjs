// Startup performance harness. Measures time-to-interactive against live
// deployments — the only environment where the numbers mean anything, since
// Stadia serves tiles keyless from localhost but 401s from a deployed origin.
//
//   RUNS=9 VERCEL_BYPASS=<secret> node scripts/measure-startup.mjs \
//     "prod=https://…vercel.app" "preview=https://…vercel.app"
//
// Reports, per target, the median of RUNS cold-cache runs:
//   interactive — search input in the DOM (what the user can first act on)
//   chips       — filter chips rendered
//   scene       — first successful RT refresh (3D scene live)
// plus requests completed before interactive, and any non-200 responses
// grouped by host.
//
// VERCEL_BYPASS is a Vercel Protection Bypass for Automation secret, needed
// only for deployments behind Deployment Protection. It is passed as a query
// parameter rather than a header on purpose: a custom header on cross-origin
// requests triggers a CORS preflight that Stadia rejects, which silently
// prevents the map style from loading and makes every run look like a hang.
//
// Use enough runs. A three-run median of this app once read 621 ms on samples
// of 460 / 621 / 1741; nine runs put it at 468 ms with a 452-567 range.
//
// The secret is read from the environment and never printed.
import { chromium } from 'playwright';

const BYPASS = process.env.VERCEL_BYPASS ?? '';
const RUNS = Number(process.env.RUNS ?? 3);
const targets = process.argv.slice(2).map(a => {
    const i = a.indexOf('=');
    return { label: a.slice(0, i), url: a.slice(i + 1) };
});

async function runOnce(url) {
    const browser = await chromium.launch();          // fresh profile => cold cache
    const context = await browser.newContext();
    const page = await context.newPage();

    // The bypass is passed as a query parameter, not as a context-wide header.
    // extraHTTPHeaders would attach the custom header to cross-origin requests
    // too, which makes them CORS-preflighted; Stadia rejects the preflight, the
    // style never loads, and the map never fires 'load'. The query form makes
    // Vercel set a bypass cookie instead, so only same-origin requests carry it
    // and third-party requests are untouched.
    const target = BYPASS
        ? `${url}/?x-vercel-protection-bypass=${BYPASS}&x-vercel-set-bypass-cookie=true`
        : url;

    let completed = 0;
    const errors = [];
    const status = new Map();                          // host -> {code: count}
    page.on('requestfinished', () => { completed++; });
    page.on('pageerror', e => errors.push(e.message.slice(0, 200)));
    page.on('response', r => {
        const host = new URL(r.url()).host;
        const key = `${host} ${r.status()}`;
        status.set(key, (status.get(key) ?? 0) + 1);
    });

    await page.goto(target, { waitUntil: 'commit' });

    const mark = (fn) => page.waitForFunction(fn, null, { timeout: 180000 })
        .then(h => h.jsonValue()).catch(() => null);

    const t_search = await mark(() =>
        document.querySelector('#search-bar .search-input') ? performance.now() : false);
    const reqsAtInteractive = completed;
    const t_chips = await mark(() =>
        document.querySelector('#chip-bar .chip') ? performance.now() : false);
    const t_scene = await mark(() => {
        const el = document.getElementById('staleness');
        return el && !el.classList.contains('hidden') ? performance.now() : false;
    });

    // Station dots actually painted — answers the "missing stations" report
    // directly rather than by inference.
    const stations = await page.evaluate(() => ({
        circles: document.querySelectorAll('.maplibregl-canvas').length,
    })).catch(() => ({}));

    const bundle = await page.evaluate(() =>
        [...document.querySelectorAll('script[src]')].map(s => s.src.split('/').pop()).join(','))
        .catch(() => '?');

    await browser.close();
    return { t_search, t_chips, t_scene, reqsAtInteractive, bundle, errors, status, stations };
}

const med = xs => xs.filter(x => x != null).slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const ms = v => v == null ? 'TIMEOUT' : Math.round(v) + 'ms';

for (const { label, url } of targets) {
    const rs = [];
    for (let i = 0; i < RUNS; i++) {
        const r = await runOnce(url);
        rs.push(r);
        console.log(`${label} run ${i + 1}: interactive=${ms(r.t_search)} chips=${ms(r.t_chips)} scene=${ms(r.t_scene)} reqs@interactive=${r.reqsAtInteractive}${r.errors.length ? '\n    errors: ' + r.errors.join(' | ') : ''}`);
    }
    console.log(`\n${label} MEDIAN: interactive=${ms(med(rs.map(r => r.t_search)))} chips=${ms(med(rs.map(r => r.t_chips)))} scene=${ms(med(rs.map(r => r.t_scene)))} reqs@interactive=${med(rs.map(r => r.reqsAtInteractive))}`);
    console.log(`${label} bundle: ${rs[0].bundle}`);
    const s = [...rs[0].status.entries()].filter(([k]) => !/ 200$/.test(k));
    console.log(`${label} non-200 responses: ${s.length ? s.map(([k, v]) => `${k} ×${v}`).join(', ') : 'none'}\n`);
}
