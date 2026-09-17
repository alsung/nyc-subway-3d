// src/ui/lines-panel.js
// Line filter: one toggle per trunk, in a panel hung off the Lines button.
//
// Replaces the twenty-nine-chip bar that used to run along the bottom edge. That
// bar showed every GTFS route, which meant three indistinguishable "S" chips
// (the shuttles all carry route_short_name S), a second SIR, and separate
// chips for the FX / 6X / 7X expresses — twenty-nine 31x24 targets crowding the
// map attribution. Grouping by trunk gives eleven rows a rider can name.
//
// Toggling is per trunk rather than per route: the lines of a trunk run the same
// corridor, so hiding one of three overlapping lines barely changes the picture
// while clearing a whole corridor does.

import { trunksFor, bulletRoutes } from '../core/trunks.js';
import { dedupeBulletRoutes } from '../core/alert-status.js';
import { routeBullet } from './route-bullet.js';

const HASH = '#lines';

/**
 * Builds the panel and its rows.
 *
 * onToggle(routeId, active) fires once per affected route — the caller drives
 * layer visibility a route at a time, so a trunk toggle reports each of its
 * routes rather than making the caller expand the group itself.
 *
 * The live-trains switch sits here rather than in the control strip because
 * this panel is already the answer to "what is drawn on the map". It stretches
 * the name "Lines" slightly, which is the price of not adding a fourth button
 * to a strip a reader already knows.
 *
 * @param {object} [options]
 * @param {(on: boolean) => void} [options.onTrainsToggle]
 * @param {boolean} [options.trainsOn] initial state of that switch
 */
export function buildLinesPanel(container, routeMap, linesButton, onToggle, options = {}) {
    const { onTrainsToggle, trainsOn = true } = options;
    const panel = document.createElement('div');
    panel.id = 'lines-panel';
    panel.classList.add('hidden');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Lines');
    panel.innerHTML = `
        <div class="lines-head">
            <span class="lines-title">Lines</span>
            <div class="lines-head-actions">
                <button class="lines-action" data-action="all">All</button>
                <button class="lines-action" data-action="none">None</button>
                <button class="lines-close" aria-label="Close">×</button>
            </div>
        </div>
        <div class="lines-body"></div>
    `;
    container.appendChild(panel);

    const body = panel.querySelector('.lines-body');
    const trunks = trunksFor(routeMap);

    // ── Live trains ─────────────────────────────────────────────────────────
    //
    // Its own section above the trunks, because it is not a line. Reading the
    // network — which train stops where, where to change — and watching it run
    // are different tasks, and the second is the one that adds movement and
    // clutter to the first.
    if (onTrainsToggle) {
        const section = document.createElement('div');
        section.className = 'lines-section';

        const row = document.createElement('button');
        row.className = 'lines-row';
        row.setAttribute('role', 'switch');
        row.setAttribute('aria-checked', String(trainsOn));
        row.classList.toggle('lines-row--off', !trainsOn);
        row.setAttribute('aria-label', 'Live trains');

        const label = document.createElement('span');
        label.className = 'lines-label';
        label.textContent = 'Live trains';

        const check = document.createElement('span');
        check.className = 'lines-check';
        check.setAttribute('aria-hidden', 'true');

        row.append(label, check);
        row.addEventListener('click', () => {
            const on = row.getAttribute('aria-checked') !== 'true';
            row.setAttribute('aria-checked', String(on));
            row.classList.toggle('lines-row--off', !on);
            onTrainsToggle(on);
        });

        section.appendChild(row);
        body.appendChild(section);
    }

    // Every trunk starts visible, matching the map on load.
    const active = new Map(trunks.map(t => [t.key, true]));
    const rows = new Map();

    function setTrunk(key, on, { notify = true } = {}) {
        if (active.get(key) === on) return;
        active.set(key, on);

        const row = rows.get(key);
        row.setAttribute('aria-checked', String(on));
        row.classList.toggle('lines-row--off', !on);

        if (!notify) return;
        for (const id of trunks.find(t => t.key === key).routeIds) onToggle(id, on);
    }

    for (const trunk of trunks) {
        const row = document.createElement('button');
        row.className = 'lines-row';
        // A switch, not a checkbox: this turns something on and off in place
        // rather than selecting it for a later submit.
        row.setAttribute('role', 'switch');
        row.setAttribute('aria-checked', 'true');

        const bullets = document.createElement('span');
        bullets.className = 'lines-bullets';
        // Two collapses, for two different reasons: bulletRoutes drops express
        // patterns nobody signs separately (FX, 6X, 7X), and dedupeBulletRoutes
        // drops the duplicate "S" bullets the three shuttles would otherwise
        // draw. Both still toggle with the trunk.
        const shown = dedupeBulletRoutes(bulletRoutes(trunk.routeIds), routeMap);
        for (const id of shown) {
            bullets.appendChild(routeBullet(id, routeMap));
        }
        // Spelled out rather than the trunk key, so a screen reader says
        // "B D F M lines" instead of reading "BDFM" as a word.
        row.setAttribute(
            'aria-label',
            `${shown.map(id => routeMap?.[id]?.shortName ?? id).join(' ')} lines`,
        );

        const check = document.createElement('span');
        check.className = 'lines-check';
        check.setAttribute('aria-hidden', 'true');

        row.append(bullets, check);
        row.addEventListener('click', () => setTrunk(trunk.key, !active.get(trunk.key)));

        body.appendChild(row);
        rows.set(trunk.key, row);
    }

    // All / None act on the lines only. "None" meaning "and also stop showing
    // trains" would make the button do two things, and there would be no way to
    // clear the lines while keeping the trains — which is a view someone might
    // actually want.
    for (const btn of panel.querySelectorAll('.lines-action')) {
        const on = btn.dataset.action === 'all';
        btn.addEventListener('click', () => {
            for (const trunk of trunks) setTrunk(trunk.key, on);
        });
    }

    // ── hash routing ────────────────────────────────────────────────────────
    //
    // Same mechanism as the alerts panel, which also means the two are mutually
    // exclusive for free: a URL carries one hash, so opening this panel puts the
    // alerts panel's syncFromHash into its else branch and closes it.

    function open()  { panel.classList.remove('hidden'); }
    function close() { panel.classList.add('hidden'); }

    function syncFromHash() {
        if (window.location.hash === HASH) open();
        else close();
    }

    window.addEventListener('hashchange', syncFromHash);

    // Not history.back(): that assumes the previous entry is one we pushed,
    // which is false when the document loaded at #lines. See the same note in
    // alerts-panel.js.
    function dismiss() {
        if (window.location.hash !== HASH) {
            close();
            return;
        }
        history.replaceState(null, '', window.location.pathname + window.location.search);
        // replaceState does not fire hashchange, so close explicitly.
        close();
    }

    panel.querySelector('.lines-close').addEventListener('click', dismiss);

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.classList.contains('hidden')) dismiss();
    });

    if (linesButton) {
        linesButton.addEventListener('click', () => {
            // Closing through dismiss() rather than clearing the hash, so the
            // button and the X leave the URL in the same state.
            if (window.location.hash === HASH) dismiss();
            else window.location.hash = 'lines';
        });
    }

    // Honor #lines on first load.
    syncFromHash();
}
