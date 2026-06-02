// src/ui/search.js
// Station name search box with live-filter dropdown.
// Filters the full stations list on every keystroke and calls onSelect
// when the user picks a result, so main.js can fly the camera and open the popup.

// Creates the search input and results dropdown, appends them to container,
// and wires up all input/keyboard/blur events internally.
// onSelect(station) is called with the full station object on result click or Enter.
export function buildSearch(stations, container, onSelect) {
    const wrapper = document.createElement('div');
    wrapper.className = 'search-wrapper';

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'search-input';
    input.placeholder = 'Search stations...';

    const results = document.createElement('ul');
    results.className = 'search-results hidden';

    wrapper.appendChild(input);
    wrapper.appendChild(results);
    container.appendChild(wrapper);

    function renderResults(query) {
        results.innerHTML = '';
        if (!query) {
            results.classList.add('hidden');
            return;
        }

        const q = query.toLowerCase();
        const matches = stations
            .filter(s => s.name.toLowerCase().includes(q))
            .slice(0, 8);

        if (matches.length === 0) {
            results.classList.add('hidden');
            return;
        }

        for (const station of matches) {
            const li = document.createElement('li');
            li.className = 'search-result';
            li.textContent = station.name;
            li.addEventListener('mousedown', (e) => {
                e.preventDefault();
                input.value = '';
                results.classList.add('hidden');
                onSelect(station);
            });
            results.appendChild(li);
        }

        results.classList.remove('hidden');
    }

    input.addEventListener('input', () => renderResults(input.value.trim()));

    input.addEventListener('blur', () => {
        results.classList.add('hidden');
    });

    input.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            input.value = '';
            results.classList.add('hidden');
            input.blur();
        }
    });
}
