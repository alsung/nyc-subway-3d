// src/core/prefs.js
// Small, durable reader/writer for the handful of choices a reader makes that
// should survive a reload.
//
// Wrapped rather than called inline because localStorage is not reliably
// available: Safari in private browsing throws on access rather than returning
// null, and a browser with site data blocked throws on read. Either would take
// init() down before the map is built, for the sake of remembering a switch.
// Every failure here degrades to the default instead.

const NAMESPACE = 'localexpress:';

/** The stored value for a key, or fallback when it is absent or unreadable. */
export function readPref(key, fallback = null) {
    try {
        const raw = window.localStorage?.getItem(NAMESPACE + key);
        return raw === null || raw === undefined ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

/** Stores a value. Silently does nothing where storage is unavailable. */
export function writePref(key, value) {
    try {
        window.localStorage?.setItem(NAMESPACE + key, JSON.stringify(value));
    } catch {
        // A preference that cannot be remembered is not worth an error.
    }
}
