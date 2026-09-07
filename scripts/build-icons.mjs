// Renders every PNG icon from the two committed SVGs.
//
// The PNGs are derived artifacts. They are committed because a build must not
// depend on a browser being installed to produce a favicon, but committing them
// alone would mean nobody could change the icon later without redrawing it by
// hand. This script is the source of truth for how they were made.
//
//   node scripts/build-icons.mjs
//
// Rendering happens in Playwright's Chromium — already a devDependency for the
// startup harness — rather than a native image library, so there is nothing new
// to install and the output matches what a browser will actually draw.
//
// Two source drawings, not one scaled asset:
//   icon.svg     three crossing routes through an interchange dot. Detailed
//                enough to reward 192px and above.
//   favicon.svg  the same idea reduced to a symmetric X with a larger dot,
//                because the detailed version collapses into a smudge at 16px.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pub = `${root}/public`;

// [source, pixel size, output, safe-zone inset]
//
// The maskable icon is inset by 20% because Android crops it to whatever shape
// the launcher uses — a circle, a squircle, a rounded square. Anything in the
// outer 20% may be cut off, so the artwork has to sit inside the middle 60%
// with the background bled to the edges.
const TARGETS = [
    ['icon.svg',    512, 'icon-512.png',          0],
    ['icon.svg',    192, 'icon-192.png',          0],
    ['icon.svg',    512, 'icon-maskable-512.png', 0.20],
    ['icon.svg',    180, 'apple-touch-icon.png',  0],
    ['favicon.svg',  32, 'favicon-32.png',        0],
    ['favicon.svg',  16, 'favicon-16.png',        0],
];

const GROUND = '#0a0a1a';

const browser = await chromium.launch();
const page = await browser.newPage();

for (const [src, size, out, inset] of TARGETS) {
    const svg = readFileSync(`${pub}/${src}`, 'utf8');
    const inner = inset
        ? `<div class="pad"><div class="art">${svg}</div></div>`
        : svg;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>
        *{margin:0;padding:0}
        html,body{width:${size}px;height:${size}px;background:${GROUND}}
        svg{display:block;width:100%;height:100%}
        .pad{width:${size}px;height:${size}px;background:${GROUND};display:grid;place-items:center}
        .art{width:${Math.round(size * (1 - inset))}px;height:${Math.round(size * (1 - inset))}px}
    </style>${inner}`);
    // omitBackground is deliberately off: an opaque ground is required for the
    // Apple touch icon (iOS composites transparency onto black) and harmless
    // everywhere else.
    await page.screenshot({ path: `${pub}/${out}` });
    console.log(`  ${out.padEnd(24)} ${size}x${size}${inset ? `  (${inset * 100}% safe-zone inset)` : ''}`);
}

// Link preview card. Shown wherever the URL is pasted — a message, a job
// application — so it is worth being deliberate rather than letting the
// scraper pick an arbitrary frame of the map.
const OG = { width: 1200, height: 630 };
mkdirSync(pub, { recursive: true });
await page.setViewportSize(OG);
await page.setContent(`<style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{width:${OG.width}px;height:${OG.height}px;background:${GROUND};
         display:flex;align-items:center;gap:64px;padding:0 96px;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff}
    .mark{width:260px;height:260px;flex-shrink:0}
    .mark svg{display:block;width:100%;height:100%}
    h1{font-size:76px;font-weight:700;letter-spacing:-0.02em;line-height:1.05}
    p{margin-top:18px;font-size:32px;line-height:1.35;color:rgba(255,255,255,0.62)}
</style>
<div class="mark">${readFileSync(`${pub}/icon.svg`, 'utf8')}</div>
<div><h1>Local Express</h1><p>Live NYC subway trains, arrivals<br>and service alerts in 3D</p></div>`);
await page.screenshot({ path: `${pub}/og-card.png` });
console.log(`  og-card.png              ${OG.width}x${OG.height}`);

await browser.close();
