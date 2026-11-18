// src/ui/line-panel.js
// The panel a /line URL opens (#154): the line's hours, MTA's description, live
// status and every stop from the north end, in the same place and frame as the
// station panel. Replaces the "G line ×" chip, which only named the line; the
// panel's ✕ is the way out now.
//
// Its HTML comes from core/place-card.js, the same code the pre-built line
// pages use, so a page's panel and the app's are one panel. This file adds the
// behavior: closing, shortening the description, and the live status.

import { linePanelElementHtml, lineHeadingHtml, lineFactsHtml } from '../core/place-card.js';
import { fillAlertBand } from './popup.js';

// How many lines of MTA's description show before "More". The A's runs to
// eight on a phone.
const DESCRIPTION_LINES = 3;

/**
 * @param {HTMLElement} container
 * @param {object} routeMap
 * @param {() => void} onClose called when ✕ is pressed
 * @returns {{element: HTMLElement, show: (model: object) => void, hide: () => void, setStatus: (alerts: object[]|null) => void}}
 */
export function buildLinePanel(container, routeMap, onClose) {
    // A pre-built line page (#155) ships the panel open and filled in; take it
    // over rather than adding a second. show() writes the same facts back.
    let panel = container.querySelector('#line-panel');
    if (!panel) {
        container.insertAdjacentHTML('beforeend', linePanelElementHtml(null, routeMap, { hidden: true }));
        panel = container.lastElementChild;
    }

    const heading = panel.querySelector('.place-heading');
    const body = panel.querySelector('.place-body');
    panel.querySelector('.popup-close').addEventListener('click', () => onClose());

    // Shortened only once it's known to run long, so the full text is what a
    // page without JavaScript shows.
    body.addEventListener('click', (e) => {
        const more = e.target.closest('.line-more');
        if (!more) return;
        const desc = body.querySelector('.line-desc');
        const open = desc.classList.toggle('is-clamped') === false;
        more.textContent = open ? 'Less' : 'More';
        more.setAttribute('aria-expanded', String(open));
    });

    function clampDescription() {
        const desc = body.querySelector('.line-desc');
        const more = body.querySelector('.line-more');
        if (!desc || !more) return;
        desc.style.setProperty('--lines', DESCRIPTION_LINES);
        desc.classList.add('is-clamped');
        const long = desc.scrollHeight > desc.clientHeight + 1;
        desc.classList.toggle('is-clamped', long);
        more.classList.toggle('hidden', !long);
    }

    return {
        element: panel,

        show(model) {
            heading.innerHTML = lineHeadingHtml(model, routeMap);
            body.innerHTML = lineFactsHtml(model, routeMap);
            body.scrollTop = 0;
            panel.classList.remove('hidden');
            clampDescription();
        },

        hide() {
            panel.classList.add('hidden');
        },

        /**
         * The line's alerts in effect now, or "Good service" when there are
         * none. Null when alerts haven't loaded, which says nothing rather than
         * claiming good service it can't vouch for.
         */
        setStatus(alerts) {
            const slot = body.querySelector('.line-status');
            if (!slot) return;
            slot.replaceChildren();
            if (alerts === null) return;
            if (alerts.length === 0) {
                const good = document.createElement('div');
                good.className = 'line-good';
                good.textContent = 'Good service';
                slot.appendChild(good);
                return;
            }
            const band = document.createElement('div');
            band.className = 'popup-alerts';
            slot.appendChild(band);
            fillAlertBand(band, alerts, routeMap);
        },
    };
}
