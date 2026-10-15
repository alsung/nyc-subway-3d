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
import { carAdvice, bestAdvice } from '../core/car-position.js';
import { getUser, onAuthChange } from '../core/auth.js';
import { hasFeature } from '../core/features.js';
import {
    getCommutes, onCommutesChange, saveCommute, updateLabel, deleteCommute, loadCommutes,
} from '../core/commutes.js';

function renderCarAdvice(legs, carDeps, nameOf) {
    const { carPositions, complexOf, stationById } = carDeps;
    if (!carPositions?.size) return null;

    const lastRide = [...legs].reverse().find(l => l.kind === 'ride');
    if (!lastRide?.stops?.length) return null;

    const destId = String(lastRide.toStop).replace(/[NS]$/, '');
    const complexFor = (id) => complexOf?.get(id);
    const stationFor = (id) => stationById?.get(id);

    const advice = carAdvice(lastRide, complexFor, stationFor, carPositions);
    const best = bestAdvice(advice);
    if (!best) return null;

    const destName = nameOf(lastRide.toStop);
    const label = best.hasElevator
        ? `Board the ${best.region} for the elevator at ${destName}`
        : `Board the ${best.region} for exits at ${destName}`;

    const li = document.createElement('li');
    li.className = 'trip-leg trip-leg--car';
    const span = document.createElement('span');
    span.textContent = label;
    li.appendChild(span);
    return li;
}

/**
 * Builds the trip planner panel.
 *
 * @param {HTMLElement} container
 * @param {object[]} entries station complexes, for the two search boxes
 * @param {object[]} stations GTFS stations, for naming stops in leg text
 * @param {object} routeMap
 * @param {HTMLElement} toggleButton
 * @param {object} carDeps  car positioning data: { carPositions, complexOf, stationById }
 * @param {{onPlan: (journey, stations) => void, onClear: () => void}} handlers
 * @param {{open: () => void}} [authModal]
 */
export function buildTripPlanner(container, entries, stations, routeMap, toggleButton, carDeps = {}, handlers = {}, authModal = null) {
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
        <div class="commutes-section"></div>
        <div class="trip-fields">
            <div class="trip-field" data-role="from"></div>
            <button class="trip-swap" aria-label="Swap origin and destination">⇅</button>
            <div class="trip-field" data-role="to"></div>
        </div>
        <div class="trip-results" aria-live="polite"></div>
    `;
    container.appendChild(panel);

    const results = panel.querySelector('.trip-results');
    const commutesSection = panel.querySelector('.commutes-section');
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

    // Look up a search entry by any of its station IDs.
    const entryByStopId = new Map();
    for (const e of entries) {
        for (const id of (e.stationIds ?? [e.id])) entryByStopId.set(id, e);
    }

    // ── Commutes section ──

    let commutesOpen = false;

    function renderCommutesSection() {
        commutesSection.innerHTML = '';
        const user = getUser();
        const enabled = hasFeature('saved_commutes');

        if (!user || !enabled) {
            if (!user && enabled) {
                const prompt = document.createElement('button');
                prompt.className = 'commutes-signin';
                prompt.type = 'button';
                prompt.textContent = 'Sign in to save commutes';
                prompt.addEventListener('click', () => authModal?.open());
                commutesSection.appendChild(prompt);
            }
            return;
        }

        const commutes = getCommutes();
        const header = document.createElement('button');
        header.className = 'commutes-toggle';
        header.type = 'button';
        header.setAttribute('aria-expanded', String(commutesOpen));
        const arrow = document.createElement('span');
        arrow.className = 'commutes-arrow';
        arrow.textContent = commutesOpen ? '▾' : '▸';
        const label = document.createElement('span');
        label.textContent = `My Commutes${commutes.length ? ` (${commutes.length})` : ''}`;
        header.append(arrow, label);
        commutesSection.appendChild(header);

        const list = document.createElement('div');
        list.className = 'commutes-list';
        if (!commutesOpen) list.classList.add('hidden');

        if (commutes.length === 0) {
            const empty = document.createElement('p');
            empty.className = 'commutes-empty';
            empty.textContent = 'No saved commutes yet. Plan a trip and save it!';
            list.appendChild(empty);
        }

        for (const c of commutes) {
            list.appendChild(renderCommuteCard(c));
        }

        commutesSection.appendChild(list);

        header.addEventListener('click', () => {
            commutesOpen = !commutesOpen;
            arrow.textContent = commutesOpen ? '▾' : '▸';
            header.setAttribute('aria-expanded', String(commutesOpen));
            list.classList.toggle('hidden', !commutesOpen);
        });
    }

    function renderCommuteCard(commute) {
        const card = document.createElement('div');
        card.className = 'commute-card';

        const body = document.createElement('button');
        body.className = 'commute-card-body';
        body.type = 'button';

        const labelEl = document.createElement('span');
        labelEl.className = 'commute-card-label';
        labelEl.textContent = commute.label;

        const route = document.createElement('span');
        route.className = 'commute-card-route';
        route.textContent = `${commute.originName} → ${commute.destName}`;

        body.append(labelEl, route);

        body.addEventListener('click', () => {
            const fromEntry = entryByStopId.get(commute.originStopId);
            const toEntry = entryByStopId.get(commute.destStopId);
            if (fromEntry) { from = fromEntry; fromSearch.setValue(fromEntry.name); }
            if (toEntry) { to = toEntry; toSearch.setValue(toEntry.name); }
            commutesOpen = false;
            renderCommutesSection();
            plan();
        });

        const actions = document.createElement('div');
        actions.className = 'commute-card-actions';

        const editBtn = document.createElement('button');
        editBtn.className = 'commute-card-edit';
        editBtn.type = 'button';
        editBtn.setAttribute('aria-label', 'Edit label');
        editBtn.textContent = '✎';
        editBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            labelEl.contentEditable = 'true';
            labelEl.focus();
            const range = document.createRange();
            range.selectNodeContents(labelEl);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(range);
        });

        const finishEdit = () => {
            labelEl.contentEditable = 'false';
            const newLabel = labelEl.textContent.trim();
            if (newLabel && newLabel !== commute.label) {
                updateLabel(commute.id, newLabel).catch(() => {
                    labelEl.textContent = commute.label;
                });
            } else {
                labelEl.textContent = commute.label;
            }
        };
        labelEl.addEventListener('blur', finishEdit);
        labelEl.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); labelEl.blur(); }
            if (e.key === 'Escape') { labelEl.textContent = commute.label; labelEl.blur(); }
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'commute-card-delete';
        deleteBtn.type = 'button';
        deleteBtn.setAttribute('aria-label', 'Delete commute');
        deleteBtn.textContent = '×';

        let confirmPending = false;
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (!confirmPending) {
                confirmPending = true;
                deleteBtn.textContent = 'Delete?';
                deleteBtn.classList.add('confirming');
                setTimeout(() => {
                    if (confirmPending) {
                        confirmPending = false;
                        deleteBtn.textContent = '×';
                        deleteBtn.classList.remove('confirming');
                    }
                }, 3000);
                return;
            }
            deleteCommute(commute.id).catch(() => {});
        });

        actions.append(editBtn, deleteBtn);
        card.append(body, actions);
        return card;
    }

    // Rebuild the section when auth state or commutes data changes.
    onAuthChange(() => {
        if (getUser()) loadCommutes();
        renderCommutesSection();
    });
    onCommutesChange(() => renderCommutesSection());
    renderCommutesSection();

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

        const carTip = renderCarAdvice(journey.legs, carDeps, nameOf);
        if (carTip) legs.appendChild(carTip);

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

    function renderSaveButton() {
        if (!hasFeature('saved_commutes') || !from || !to) return;

        const alreadySaved = getCommutes().some(
            c => c.originStopId === from.id && c.destStopId === to.id
        );
        if (alreadySaved) return;

        const btn = document.createElement('button');
        btn.className = 'trip-save-btn';
        btn.type = 'button';
        btn.textContent = getUser() ? 'Save this trip' : 'Sign in to save this trip';

        btn.addEventListener('click', async () => {
            if (!getUser()) {
                authModal?.open();
                return;
            }
            btn.disabled = true;
            btn.textContent = 'Saving…';
            try {
                await saveCommute(
                    from.id, from.name,
                    to.id, to.name,
                    '',
                );
                btn.textContent = 'Saved!';
                btn.classList.add('saved');
                setTimeout(() => btn.remove(), 1500);
            } catch (err) {
                btn.textContent = err.message || 'Failed to save';
                btn.disabled = false;
                setTimeout(() => { btn.textContent = 'Save this trip'; }, 2000);
            }
        });

        results.appendChild(btn);
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
            renderSaveButton();
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
