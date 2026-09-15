// src/ui/trip-planner.js
// Origin/destination search, itinerary list, and the leg breakdown.
//
// The logic that can be wrong on its own lives in src/core/plan.js and is tested
// there. What is left here is DOM wiring and event handling, verified in a
// browser — the same division the popup and the panels already use.

import { buildSearch } from './search.js';
import { routeBullet } from './route-bullet.js';
import { fetchPlan } from '../core/rt-loader.js';
import { searchEntryLabel } from '../core/station-meta.js';
import {
    normalizePlan, formatClock, formatDuration, formatTransfers, describeLeg,
} from '../core/plan.js';

/**
 * Builds the trip planner panel.
 *
 * @param {HTMLElement} container
 * @param {object[]} entries station complexes, for the two search boxes
 * @param {object[]} stations GTFS stations, for naming stops in leg text
 * @param {object} routeMap
 * @param {HTMLElement} toggleButton
 * @param {{onPlan: (journey, stations) => void, onClear: () => void}} handlers
 */
export function buildTripPlanner(container, entries, stations, routeMap, toggleButton, handlers = {}) {
    const nameById = new Map(stations.map(s => [s.id, s.name]));
    // Platform ids come back from the API (127N); the rider knows the station.
    const nameOf = (stopId) => nameById.get(stopId)
        ?? nameById.get(String(stopId).replace(/[NS]$/, ''))
        ?? stopId;

    const panel = document.createElement('div');
    panel.id = 'trip-panel';
    panel.className = 'side-panel hidden';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Plan a trip');
    panel.innerHTML = `
        <div class="panel-head">
            <span class="panel-title">Plan a trip</span>
            <button class="panel-close" aria-label="Close trip planner">×</button>
        </div>
        <div class="trip-fields">
            <div class="trip-field" data-role="from"></div>
            <button class="trip-swap" aria-label="Swap origin and destination">⇅</button>
            <div class="trip-field" data-role="to"></div>
        </div>
        <div class="trip-results" aria-live="polite"></div>
    `;
    container.appendChild(panel);

    const results = panel.querySelector('.trip-results');
    let from = null;
    let to = null;

    const fromSearch = buildSearch(entries, panel.querySelector('[data-role="from"]'),
        (station) => { from = station; plan(); },
        { idPrefix: 'trip-from', placeholder: 'From station…', ariaLabel: 'Origin results',
          clearOnSelect: false, routeMap, labelFor: searchEntryLabel });

    const toSearch = buildSearch(entries, panel.querySelector('[data-role="to"]'),
        (station) => { to = station; plan(); },
        { idPrefix: 'trip-to', placeholder: 'To station…', ariaLabel: 'Destination results',
          clearOnSelect: false, routeMap, labelFor: searchEntryLabel });

    function message(text, tone = '') {
        results.innerHTML = '';
        const p = document.createElement('p');
        p.className = `trip-message${tone ? ` trip-message--${tone}` : ''}`;
        p.textContent = text;
        results.appendChild(p);
    }

    function renderJourney(journey, index) {
        const row = document.createElement('div');
        row.className = 'trip-journey';

        const summary = document.createElement('button');
        summary.className = 'trip-summary';
        summary.setAttribute('aria-expanded', 'false');
        summary.setAttribute('aria-controls', `trip-legs-${index}`);

        const bullets = document.createElement('span');
        bullets.className = 'trip-bullets';
        for (const routeId of journey.rides) bullets.appendChild(routeBullet(routeId, routeMap));

        const meta = document.createElement('span');
        meta.className = 'trip-meta';
        meta.textContent = `${formatDuration(journey.minutes)} · ${formatTransfers(journey.transfers)}`;

        const times = document.createElement('span');
        times.className = 'trip-times';
        times.textContent = `${formatClock(journey.departAt)} → ${formatClock(journey.arriveAt)}`;
        if (journey.realtime) {
            const live = document.createElement('span');
            live.className = 'trip-live';
            live.textContent = 'live';
            live.title = 'Some legs use live arrival predictions';
            times.appendChild(live);
        }

        summary.append(bullets, meta, times);

        const legs = document.createElement('ol');
        legs.className = 'trip-legs hidden';
        legs.id = `trip-legs-${index}`;
        for (const leg of journey.legs) {
            const li = document.createElement('li');
            li.className = `trip-leg trip-leg--${leg.kind}`;
            if (leg.kind === 'ride' && leg.routeId) {
                li.appendChild(routeBullet(leg.routeId, routeMap));
            }
            const text = document.createElement('span');
            text.textContent = describeLeg(leg, nameOf);
            li.appendChild(text);
            if (leg.timing === 'realtime') li.classList.add('trip-leg--live');
            legs.appendChild(li);
        }

        summary.addEventListener('click', () => {
            const open = !legs.classList.contains('hidden');
            for (const other of results.querySelectorAll('.trip-legs')) other.classList.add('hidden');
            for (const other of results.querySelectorAll('.trip-summary')) other.setAttribute('aria-expanded', 'false');
            if (!open) {
                legs.classList.remove('hidden');
                summary.setAttribute('aria-expanded', 'true');
                handlers.onPlan?.(journey, { from, to });
            } else {
                handlers.onClear?.();
            }
        });

        row.append(summary, legs);
        return row;
    }

    // Every GTFS station in a complex, as the API's comma-separated list.
    const stopsOf = (entry) => (entry?.stationIds?.length ? entry.stationIds : [entry.id]).join(',');

    async function plan() {
        if (!from || !to) return;
        if (from.id === to.id) {
            message('Origin and destination are the same station.');
            return;
        }
        message('Planning…');

        try {
            // Every platform group of the complex, not just the first. Planning
            // from Times Sq's 1/2/3 platform alone returns 14 min via the E,
            // where the whole complex finds 13 via the Q — the rider picked the
            // station, so the router should see all of it.
            const raw = await fetchPlan(stopsOf(from), stopsOf(to));
            const { journeys } = normalizePlan(raw);
            results.innerHTML = '';

            if (journeys.length === 0) {
                message('No trips found right now. Service may not be running between these stations.');
                return;
            }
            journeys.forEach((j, i) => results.appendChild(renderJourney(j, i)));
        } catch (err) {
            // Trip planning is additive: the map keeps working without it, so
            // this says so plainly rather than taking anything else down.
            console.warn(`[trip-planner] plan failed: ${err.message}`);
            message('Trip planning is unavailable right now.', 'error');
        }
    }

    panel.querySelector('.trip-swap').addEventListener('click', () => {
        [from, to] = [to, from];
        fromSearch.setValue(from?.name ?? '');
        toSearch.setValue(to?.name ?? '');
        handlers.onClear?.();
        plan();
    });

    const dismiss = () => {
        panel.classList.add('hidden');
        toggleButton?.setAttribute('aria-expanded', 'false');
        handlers.onClear?.();
    };

    panel.querySelector('.panel-close').addEventListener('click', dismiss);

    toggleButton?.addEventListener('click', () => {
        const opening = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !opening);
        toggleButton.setAttribute('aria-expanded', String(opening));
        if (opening) fromSearch.input.focus();
        else handlers.onClear?.();
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !panel.classList.contains('hidden')) dismiss();
    });

    return { panel, dismiss };
}
