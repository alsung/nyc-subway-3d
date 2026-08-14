// src/ui/alerts-panel.js
// Service status overlay: one row per trunk, expandable to the alerts affecting
// it.
//
// Deliberately an overlay rather than a second page. The map, the Three.js
// scene and the GTFS data are already loaded and animating; a separate entry
// point would reload all of it to show a list. The panel is addressed by URL
// hash (#alerts) so it stays linkable and the back button behaves, which is the
// only part of a router this app actually needs.

import { fetchAlertSummary, fetchAlerts } from '../core/rt-loader.js';
import { trunkDisplay, systemTone, alertsForTrunk, dedupeBulletRoutes } from '../core/alert-status.js';
import { contrastColor } from '../core/color.js';

const HASH = '#alerts';

// Alerts refresh server-side every 60s, so re-fetching more often than that
// cannot return anything new.
const CACHE_MS = 60_000;

export function buildAlertsPanel(container, routeMap, statusButton) {
    const panel = document.createElement('div');
    panel.id = 'alerts-panel';
    panel.classList.add('hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Service status');
    panel.innerHTML = `
        <div class="alerts-head">
            <span class="alerts-title">Service Status</span>
            <button class="alerts-close" aria-label="Close">×</button>
        </div>
        <div class="alerts-body"></div>
    `;
    container.appendChild(panel);

    const body = panel.querySelector('.alerts-body');
    let cache = null;          // { summary, alerts, at }
    let inFlight = null;       // dedupes concurrent opens

    // ── data ────────────────────────────────────────────────────────────────

    async function load() {
        if (cache && Date.now() - cache.at < CACHE_MS) return cache;
        if (inFlight) return inFlight;

        inFlight = (async () => {
            // Both are small and independent; failing one should not blank the
            // other, so they settle rather than race to a rejection.
            const [s, a] = await Promise.allSettled([fetchAlertSummary(), fetchAlerts()]);
            if (s.status === 'rejected' && a.status === 'rejected') {
                throw s.reason;
            }
            cache = {
                summary: s.status === 'fulfilled' ? s.value : null,
                alerts: a.status === 'fulfilled' ? a.value.alerts : [],
                at: Date.now(),
            };
            return cache;
        })();

        try {
            return await inFlight;
        } finally {
            inFlight = null;
        }
    }

    // ── rendering ───────────────────────────────────────────────────────────

    function routeBullet(routeId) {
        const route = routeMap[routeId];
        const color = route?.color ?? '#808183';
        const el = document.createElement('span');
        el.className = 'alert-bullet';
        el.textContent = route?.shortName ?? routeId;
        el.style.backgroundColor = color;
        el.style.color = contrastColor(color);
        if ((route?.shortName ?? routeId).length > 2) el.classList.add('alert-bullet--wide');
        return el;
    }

    function renderMessage(text) {
        body.innerHTML = '';
        const el = document.createElement('div');
        el.className = 'alerts-message';
        el.textContent = text;
        body.appendChild(el);
    }

    function renderRows(summary, alerts) {
        body.innerHTML = '';

        if (!summary?.trunks?.length) {
            renderMessage('Status is unavailable right now.');
            return;
        }

        for (const trunk of summary.trunks) {
            const display = trunkDisplay(trunk);

            const row = document.createElement('div');
            row.className = `alert-row alert-row--${display.tone}`;

            const header = document.createElement(display.interactive ? 'button' : 'div');
            header.className = 'alert-row-head';
            if (display.interactive) header.setAttribute('aria-expanded', 'false');

            const bullets = document.createElement('span');
            bullets.className = 'alert-bullets';
            for (const id of dedupeBulletRoutes(trunk.routeIds, routeMap)) {
                bullets.appendChild(routeBullet(id));
            }

            const status = document.createElement('span');
            status.className = `alert-row-status alert-row-status--${display.tone}`;
            status.textContent = display.text;

            header.append(bullets, status);
            if (display.interactive) {
                const chev = document.createElement('span');
                chev.className = 'alert-chev';
                chev.textContent = '›';
                header.appendChild(chev);
            }
            row.appendChild(header);

            if (display.interactive) {
                const detail = document.createElement('div');
                detail.className = 'alert-detail hidden';
                for (const alert of alertsForTrunk(alerts, trunk.routeIds)) {
                    detail.appendChild(renderAlert(alert));
                }
                // The summary counts alerts per trunk while the list is derived
                // from routeIds; if they ever disagree, say so rather than
                // showing an empty expansion.
                if (!detail.children.length) {
                    const empty = document.createElement('div');
                    empty.className = 'alerts-message';
                    empty.textContent = 'Details unavailable.';
                    detail.appendChild(empty);
                }
                row.appendChild(detail);

                header.addEventListener('click', () => {
                    const open = detail.classList.toggle('hidden');
                    header.setAttribute('aria-expanded', String(!open));
                    row.classList.toggle('alert-row--open', !open);
                });
            }

            body.appendChild(row);
        }

        // Upcoming planned work is a separate destination (P6-5b); until it
        // exists, report the count rather than offering a row that goes nowhere.
        if (summary.upcoming > 0) {
            const note = document.createElement('div');
            note.className = 'alerts-foot';
            note.textContent = `${summary.upcoming} planned service change${summary.upcoming === 1 ? '' : 's'} scheduled`;
            body.appendChild(note);
        }
    }

    function renderAlert(alert) {
        const el = document.createElement('div');
        el.className = 'alert-item';

        const top = document.createElement('div');
        top.className = 'alert-item-top';
        for (const id of dedupeBulletRoutes(alert.routeIds, routeMap)) {
            top.appendChild(routeBullet(id));
        }

        const label = document.createElement('span');
        label.className = `alert-item-label alert-item-label--${alert.kind}`;
        label.textContent = alert.label ?? '';
        top.appendChild(label);

        const text = document.createElement('div');
        text.className = 'alert-item-text';
        // textContent, never innerHTML: this is third-party copy, and the feed
        // also ships an en-html variant we deliberately never touch.
        text.textContent = alert.header ?? '';

        el.append(top, text);

        if (alert.periodText) {
            const period = document.createElement('div');
            period.className = 'alert-item-period';
            period.textContent = alert.periodText;
            el.appendChild(period);
        }
        return el;
    }

    // ── open / close ────────────────────────────────────────────────────────

    async function open() {
        panel.classList.remove('hidden');
        renderMessage('Loading…');
        try {
            const { summary, alerts } = await load();
            // The panel may have been closed while the request was in flight.
            if (panel.classList.contains('hidden')) return;
            renderRows(summary, alerts);
            updateStatusButton(summary);
        } catch {
            if (panel.classList.contains('hidden')) return;
            renderMessage('Couldn’t load service status.');
        }
    }

    function close() {
        panel.classList.add('hidden');
    }

    function updateStatusButton(summary) {
        if (!statusButton) return;
        const tone = systemTone(summary?.trunks);
        statusButton.dataset.tone = tone;
    }

    // ── hash routing ────────────────────────────────────────────────────────

    function syncFromHash() {
        if (window.location.hash === HASH) open();
        else close();
    }

    window.addEventListener('hashchange', syncFromHash);

    panel.querySelector('.alerts-close').addEventListener('click', () => {
        // Going through the hash keeps the URL and the panel in agreement,
        // whichever way it was opened.
        if (window.location.hash === HASH) history.back();
        else close();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.classList.contains('hidden')) {
            if (window.location.hash === HASH) history.back();
            else close();
        }
    });

    // Honour #alerts on first load.
    syncFromHash();

    // Prime the ambient dot without opening anything. A failure here is silent
    // by design: the button still works, it just shows no tone.
    load().then(({ summary }) => updateStatusButton(summary)).catch(() => {});

    return { open, close, element: panel };
}
