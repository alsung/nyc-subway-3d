// src/ui/search.js
// Station name search box with live-filter dropdown.
// Filters the full stations list on every keystroke and calls onSelect
// when the user picks a result, so main.js can fly the camera and open the popup.

// How many matches the dropdown shows. Enough to find what you meant, few
// enough to scan without scrolling.
export const MAX_RESULTS = 8;

/**
 * The stations whose name contains the query, case-insensitively.
 *
 * Separated from the DOM so the matching itself can be tested: everything else
 * in this file is event wiring.
 */
export function filterStations(stations, query, limit = MAX_RESULTS) {
    const q = String(query ?? '').trim().toLowerCase();
    if (!q) return [];
    return (stations ?? [])
        .filter(s => s?.name?.toLowerCase().includes(q))
        .slice(0, limit);
}

// Every instance gets its own id namespace. Two search boxes on one page — the
// map's and the trip planner's origin and destination fields — would otherwise
// both claim id="search-results", and aria-controls would point at whichever
// the browser resolved first. A duplicate id does not throw; it just quietly
// aims a screen reader at the wrong list.
let instanceCount = 0;

/**
 * The DOM ids one search instance owns.
 *
 * Exported so the uniqueness can be asserted without a DOM.
 */
export function idsFor(prefix) {
    return {
        listbox: `${prefix}-results`,
        option: (i) => `${prefix}-result-${i}`,
    };
}

/**
 * Creates the search input and results dropdown, appends them to container,
 * and wires up all input/keyboard/blur events internally.
 *
 * onSelect(station) is called with the full station object on result click or
 * Enter.
 *
 * The dropdown is an ARIA combobox driven by aria-activedescendant: arrow keys
 * move a highlight through the options while DOM focus stays in the input. The
 * alternative — moving real focus onto each <li> — would fire the input's blur
 * handler and collapse the list on the first ArrowDown.
 *
 * @param {object[]} stations
 * @param {HTMLElement} container
 * @param {(station: object) => void} onSelect
 * @param {{idPrefix?: string, placeholder?: string, ariaLabel?: string,
 *          clearOnSelect?: boolean}} [options]
 * @returns {{input: HTMLInputElement, wrapper: HTMLElement,
 *            setValue: (text: string) => void, clear: () => void}}
 */
export function buildSearch(stations, container, onSelect, options = {}) {
    const {
        idPrefix = `search-${++instanceCount}`,
        placeholder = 'Search stations...',
        ariaLabel = 'Station results',
        // The map's search empties itself after a pick, because the query was a
        // means to an end. A trip planner field is the opposite: the chosen
        // station is the value, and clearing it would erase what you just set.
        clearOnSelect = true,
    } = options;
    const ids = idsFor(idPrefix);

    const wrapper = document.createElement('div');
    wrapper.className = 'search-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input';
    input.placeholder = placeholder;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', ids.listbox);

    const results = document.createElement('ul');
    results.className = 'search-results hidden';
    results.id = ids.listbox;
    results.setAttribute('role', 'listbox');
    results.setAttribute('aria-label', ariaLabel);

    wrapper.appendChild(input);
    wrapper.appendChild(results);
    container.appendChild(wrapper);

    // The stations currently listed, and which one the arrow keys have landed
    // on. -1 means the list is showing but nothing is highlighted yet, so Enter
    // does nothing — pressing it should not select an arbitrary first match the
    // user never saw highlighted.
    let matches = [];
    let activeIndex = -1;

    function closeResults() {
        results.classList.add('hidden');
        input.setAttribute('aria-expanded', 'false');
        activeIndex = -1;
        // Clears the highlight class off the options as well as the ARIA
        // pointer. Without this the last highlighted row keeps its class while
        // the list is hidden, and would flash back into view if the same list
        // were ever shown again without being re-rendered.
        syncActive();
    }

    // Mirrors activeIndex into the DOM: the visible highlight, the ARIA pointer
    // screen readers announce, and scroll position if the list ever outgrows
    // its box.
    function syncActive() {
        const items = results.children;
        for (let i = 0; i < items.length; i++) {
            const on = i === activeIndex;
            items[i].classList.toggle('search-result--active', on);
            items[i].setAttribute('aria-selected', String(on));
        }
        if (activeIndex < 0) {
            input.removeAttribute('aria-activedescendant');
            return;
        }
        const active = items[activeIndex];
        input.setAttribute('aria-activedescendant', active.id);
        active.scrollIntoView({ block: 'nearest' });
    }

    function select(station) {
        input.value = clearOnSelect ? '' : station.name;
        closeResults();
        onSelect(station);
    }

    function renderResults(query) {
        results.innerHTML = '';
        activeIndex = -1;

        if (!query) {
            matches = [];
            closeResults();
            return;
        }

        matches = filterStations(stations, query);

        if (matches.length === 0) {
            closeResults();
            return;
        }

        matches.forEach((station, i) => {
            const li = document.createElement('li');
            li.className = 'search-result';
            li.id = ids.option(i);
            li.setAttribute('role', 'option');
            li.setAttribute('aria-selected', 'false');
            li.textContent = station.name;
            // mousedown rather than click, and preventDefault, so the selection
            // lands before the input's blur handler can hide the list.
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                select(station);
            });
            results.appendChild(li);
        });

        results.classList.remove('hidden');
        input.setAttribute('aria-expanded', 'true');
        syncActive();
    }

    input.addEventListener('input', () => renderResults(input.value.trim()));

    input.addEventListener('blur', () => closeResults());

    input.addEventListener('keydown', (e) => {
        const open = !results.classList.contains('hidden');

        switch (e.key) {
            case 'ArrowDown':
                if (!open) return;
                e.preventDefault();
                // Wraps at both ends, so holding either arrow cycles the list
                // rather than stalling silently against a stop.
                activeIndex = activeIndex >= matches.length - 1 ? 0 : activeIndex + 1;
                syncActive();
                break;

            case 'ArrowUp':
                if (!open) return;
                e.preventDefault();
                activeIndex = activeIndex <= 0 ? matches.length - 1 : activeIndex - 1;
                syncActive();
                break;

            case 'Enter':
                if (!open || activeIndex < 0) return;
                e.preventDefault();
                select(matches[activeIndex]);
                break;

            case 'Escape':
                input.value = '';
                closeResults();
                input.blur();
                break;
        }
    });

    return {
        input,
        wrapper,
        setValue(text) {
            input.value = text ?? '';
            closeResults();
        },
        clear() {
            input.value = '';
            closeResults();
        },
    };
}
