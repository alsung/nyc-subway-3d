// src/ui/search-home.js
// The home panel under the search bar (#155): the site's heading, what it
// does, and a link to every line page.
//
// It works the way a maps app's search does: click the search box and the
// panel drops down from it, start typing and the station results take its
// place, clear the box and it comes back. The home page opens it on a wide
// screen, where it sits over New Jersey; a phone waits for the search box,
// because there the panel would cover the controls and half the map.
//
// The home page ships the panel in its HTML (scripts/build-seo-pages.mjs), so
// crawlers and visitors without JavaScript read the same heading and links;
// this takes that copy over. Other pages don't carry it, so a station page has
// one heading, its station's; here the panel is added the first time it opens.

import { searchHomeElementHtml } from '../core/place-card.js';

// The phone layout's breakpoint, the same as the (max-width: 640px) blocks in
// styles.css.
export const PHONE_QUERY = '(max-width: 640px)';

// What the panel leaves of the visible height: its top edge under the search
// box (64px, see .search-home in styles.css) and a 20px gap at the bottom.
const VIEWPORT_MARGIN = 84;

/**
 * @param {HTMLElement} container #ui
 * @param {object} options
 * @param {object} options.routeMap
 * @param {string[]} options.lineIds lines that have a page
 * @param {HTMLElement} options.anchor #search-bar: the panel goes right after
 *   it, and clicks inside it don't count as clicking away
 * @param {boolean} [options.openOnLoad]
 * @param {(e: MouseEvent) => void} [options.onLinkClick] opens a line link in
 *   the app instead of loading its page
 * @returns {{readonly element: HTMLElement|null, open: () => void,
 *            close: (options?: {refocus?: boolean}) => void, isOpen: () => boolean}}
 */
export function buildSearchHome(container, { routeMap, lineIds, anchor, openOnLoad = false, onLinkClick } = {}) {
    let panel = container.querySelector('#search-home');
    // Set while focus goes back to the search box after ✕, so that focusing
    // the box doesn't open the panel it just closed.
    let refocusing = false;

    const isOpen = () => Boolean(panel && !panel.classList.contains('hidden'));

    const wire = (el) => {
        // detail is 0 for a click made with the keyboard. Focus was on ✕, which
        // is about to disappear, so it goes back to the search box.
        el.querySelector('.popup-close').addEventListener('click', (e) => close({ refocus: e.detail === 0 }));
        if (onLinkClick) el.addEventListener('click', onLinkClick);
    };

    const create = () => {
        const html = searchHomeElementHtml(routeMap, lineIds, { hidden: true });
        if (anchor?.parentElement === container) anchor.insertAdjacentHTML('afterend', html);
        else container.insertAdjacentHTML('beforeend', html);
        panel = container.querySelector('#search-home');
        wire(panel);
    };

    // On a phone the keyboard covers the bottom of the screen without
    // shrinking the page, so the panel's height comes from the part still
    // visible. A wide screen gets its full height less the margins, the same
    // as styles.css's fallback.
    const viewport = window.visualViewport;
    const fit = () => {
        if (!panel || !viewport) return;
        panel.style.setProperty('--search-home-max', `${Math.round(viewport.height - VIEWPORT_MARGIN)}px`);
    };
    viewport?.addEventListener('resize', () => { if (isOpen()) fit(); });

    function open() {
        if (refocusing || isOpen()) return;
        if (!panel) {
            create();
            // Laid out closed first, so it drops in rather than appearing.
            void panel.offsetWidth;
        }
        fit();
        panel.classList.remove('hidden');
    }

    function close({ refocus = false } = {}) {
        if (!isOpen()) return;
        panel.classList.add('hidden');
        if (!refocus) return;
        refocusing = true;
        anchor?.querySelector('input')?.focus();
        refocusing = false;
    }

    if (panel) {
        // The home page's copy: open on a wide screen and hidden by CSS on a
        // phone until now. From here the hidden class alone decides.
        panel.classList.toggle('hidden', !openOnLoad);
        panel.classList.remove('search-home--landing');
        wire(panel);
    } else if (openOnLoad) {
        create();
        fit();
        panel.classList.remove('hidden');
    }

    // Clicking or tabbing anywhere else closes it: the map, the controls, a
    // panel. The search box and the panel itself don't count, so a click on a
    // result or a Tab into the line links leaves it be. Capture, so a handler
    // that stops the event on its way in can't keep the panel open.
    const away = (node) => !(panel?.contains(node) || anchor?.contains(node));
    document.addEventListener('pointerdown', (e) => { if (isOpen() && away(e.target)) close(); }, true);
    document.addEventListener('focusin', (e) => { if (isOpen() && away(e.target)) close(); });

    // One press closes one thing (#145): a panel that took the key first has
    // already marked it, and the station and line panels underneath listen on
    // window, which the key reaches after this.
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape' || e.defaultPrevented || !isOpen()) return;
        e.preventDefault();
        close({ refocus: panel.contains(document.activeElement) });
    });

    return {
        get element() { return panel; },
        open,
        close,
        isOpen,
    };
}
