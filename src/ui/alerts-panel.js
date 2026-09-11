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
import { parseAlertText } from '../core/alert-text.js';
import { routeBullet as bullet } from './route-bullet.js';

const HASH = '#alerts';

// Alerts refresh server-side every 60s, so re-fetching more often than that
// cannot return anything new.
const CACHE_MS = 60_000;

// stations powers the affected-station chips; onStationSelect is invoked when
// one is tapped. The panel deliberately knows nothing about the map or the
// popup — main.js owns those and supplies the callback, the same shape
// buildSearch already uses.
export function buildAlertsPanel(container, routeMap, stations, statusButton, onStationSelect) {
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

    // Alert stopIds are parent station IDs, which match the GTFS ids the map
    // renders directly — verified against the live feed at 443/443.
    const stationById = new Map((stations ?? []).map(st => [st.id, st]));

    // How many chips to show before collapsing. Alerts carry a median of 7
    // affected stations and up to 40; forty chips would bury the alert text.
    const CHIP_LIMIT = 6;
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

    // Binds the shared bullet renderer to this panel's routeMap, so the call
    // sites below read the same as before the helper moved out.
    const routeBullet = (routeId) => bullet(routeId, routeMap);

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

        // Planned work is kept out of the trunk rows on purpose: the large
        // majority of the feed is scheduled work, and folding it in would mark
        // nearly every line disrupted and make the list meaningless.
        if (summary.upcoming > 0) {
            const entry = document.createElement('button');
            entry.className = 'alerts-foot alerts-foot--link';
            entry.innerHTML = '';
            const label = document.createElement('span');
            label.textContent = `${summary.upcoming} planned service change${summary.upcoming === 1 ? '' : 's'} scheduled`;
            const chev = document.createElement('span');
            chev.className = 'alert-chev';
            chev.textContent = '›';
            entry.append(label, chev);
            entry.addEventListener('click', showPlanned);
            body.appendChild(entry);
        }
    }

    // ── planned service changes ─────────────────────────────────────────────

    // Upcoming work is only fetched when this view is opened. The full response
    // is ~25 KB gzipped against ~1.2 KB for the default, so it is not worth
    // pulling for the status list that most visitors will only ever see.
    let plannedCache = null;

    async function showPlanned() {
        renderPlannedShell();
        const list = body.querySelector('.planned-list');
        try {
            if (!plannedCache || Date.now() - plannedCache.at >= CACHE_MS) {
                const res = await fetchAlerts(true);
                plannedCache = { alerts: res.alerts ?? [], at: Date.now() };
            }
            // The user may have navigated back while this was in flight.
            if (!body.contains(list)) return;
            renderPlannedList(list, plannedCache.alerts.filter(a => !a.surfaced));
        } catch {
            if (!body.contains(list)) return;
            list.innerHTML = '';
            const msg = document.createElement('div');
            msg.className = 'alerts-message';
            msg.textContent = 'Couldn\u2019t load planned service changes.';
            list.appendChild(msg);
        }
    }

    function renderPlannedShell() {
        body.innerHTML = '';

        const back = document.createElement('button');
        back.className = 'alerts-back';
        back.textContent = '\u2039  Service Status';
        back.addEventListener('click', () => {
            if (cache) renderRows(cache.summary, cache.alerts);
            else open();
        });
        body.appendChild(back);

        const heading = document.createElement('div');
        heading.className = 'planned-heading';
        heading.textContent = 'Planned service changes';
        body.appendChild(heading);

        const list = document.createElement('div');
        list.className = 'planned-list';
        const loading = document.createElement('div');
        loading.className = 'alerts-message';
        loading.textContent = 'Loading\u2026';
        list.appendChild(loading);
        body.appendChild(list);
    }

    function renderPlannedList(list, alerts) {
        list.innerHTML = '';
        if (!alerts.length) {
            const msg = document.createElement('div');
            msg.className = 'alerts-message';
            msg.textContent = 'No planned service changes scheduled.';
            list.appendChild(msg);
            return;
        }
        for (const alert of alerts) {
            list.appendChild(renderAlert(alert));
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
        // Route tokens ([N], [B][Q]) become real bullets; everything else goes
        // in as textContent. innerHTML is never used — this is third-party copy,
        // and the feed also ships an en-html variant we deliberately ignore.
        for (const seg of parseAlertText(alert.header)) {
            if (seg.route !== undefined) {
                const b = routeBullet(seg.route);
                b.classList.add('alert-bullet--inline');
                text.appendChild(b);
            } else {
                text.appendChild(document.createTextNode(seg.text));
            }
        }

        el.append(top, text);

        if (alert.periodText) {
            const period = document.createElement('div');
            period.className = 'alert-item-period';
            period.textContent = alert.periodText;
            el.appendChild(period);
        }

        const chips = renderStationChips(alert);
        if (chips) el.appendChild(chips);

        return el;
    }

    // Affected stations, tappable. This is the thing a list of alerts cannot do
    // on its own: tapping flies the map to the station and opens its popup, so
    // "N skips 28 St, 23 St, 8 St-NYU" becomes something you can see.
    function renderStationChips(alert) {
        const found = (alert.stopIds ?? [])
            .map(id => stationById.get(id))
            .filter(Boolean);
        if (!found.length) return null;

        // Dedupe by name: a complex spans several GTFS ids that share one name,
        // and repeating "Times Sq-42 St" four times is noise.
        const seen = new Set();
        const unique = found.filter(st => !seen.has(st.name) && seen.add(st.name));

        const wrap = document.createElement('div');
        wrap.className = 'alert-stations';

        const label = document.createElement('div');
        label.className = 'alert-stations-label';
        label.textContent = unique.length === 1
            ? '1 station affected'
            : `${unique.length} stations affected`;
        wrap.appendChild(label);

        const list = document.createElement('div');
        list.className = 'alert-chips';
        wrap.appendChild(list);

        const addChip = (st) => {
            const chip = document.createElement('button');
            chip.className = 'alert-chip';
            chip.textContent = st.name;
            chip.addEventListener('click', () => onStationSelect?.(st));
            list.appendChild(chip);
        };

        unique.slice(0, CHIP_LIMIT).forEach(addChip);

        // Median is 7 affected stations and the maximum observed is 40, so the
        // overflow case is the common one rather than an edge case.
        if (unique.length > CHIP_LIMIT) {
            const more = document.createElement('button');
            more.className = 'alert-chip alert-chip--more';
            more.textContent = `+${unique.length - CHIP_LIMIT} more`;
            more.addEventListener('click', () => {
                more.remove();
                unique.slice(CHIP_LIMIT).forEach(addChip);
            });
            list.appendChild(more);
        }
        return wrap;
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

    // Closes the panel and takes #alerts out of the URL, so the two stay in
    // agreement however the panel was opened.
    //
    // This must not be history.back(). Going back assumes the previous entry is
    // one we pushed, and that is not true whenever the document *loaded* at
    // #alerts — a reload with the panel open, a bookmark, or a shared link. In
    // those cases there is no earlier same-document entry, so back() either does
    // nothing at all or navigates off the site entirely, and the close button
    // looks dead. replaceState drops the hash from the current entry instead,
    // which works from any history state and leaves no entry behind that would
    // reopen the panel on Back.
    //
    // The browser and Android back buttons still close the panel: opening it
    // pushes an entry, and going back from that fires hashchange above.
    function dismiss() {
        if (window.location.hash !== HASH) {
            close();
            return;
        }
        history.replaceState(null, '', window.location.pathname + window.location.search);
        // replaceState does not fire hashchange, so close explicitly.
        close();
    }

    panel.querySelector('.alerts-close').addEventListener('click', dismiss);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.classList.contains('hidden')) dismiss();
    });

    // Honor #alerts on first load.
    syncFromHash();

    // Prime the ambient dot without opening anything. A failure here is silent
    // by design: the button still works, it just shows no tone.
    load().then(({ summary }) => updateStatusButton(summary)).catch(() => {});

    return { open, close, element: panel };
}
