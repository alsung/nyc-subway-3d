#!/usr/bin/env bash
# Downloads the two static datasets the app needs into public/:
#
#   gtfs/*.txt      the MTA GTFS static ZIP, extracted to four files
#   stations.json   per-station borough and direction labels, from MTA's own
#                   open-data portal
#
# This runs automatically as npm's `prebuild` hook, so any `npm run build` —
# local, CI, or Vercel's own build — produces a dist/ that contains the data.
# It used to be a separate step the caller had to remember, which is exactly
# how every Vercel deployment shipped without it: the workflow ran the download,
# but the output Vercel actually serves comes from `vercel build` re-running
# `npm run build` in an environment where public/gtfs/ was empty.
#
# Already-present files are left alone so local rebuilds don't re-fetch 5.6 MB.
# CI is a clean checkout (public/gtfs/*.txt is gitignored), so it always
# downloads fresh. Pass --force to re-download regardless.
set -euo pipefail

GTFS_URL="http://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"
OUT_DIR="$(dirname "$0")/../public/gtfs"
FILES=(stops.txt routes.txt shapes.txt trips.txt)

# MTA Subway Stations, from the state open-data portal. Supplies three things
# GTFS itself does not carry: which platforms form one station complex, each
# station's borough, and the direction labels MTA uses in its own app
# ("Uptown"/"Downtown", "Manhattan"/"Queens").
#
# complex_id is the one that matters most. Grouping platforms by station name
# instead merges genuinely different stations: NYC has six separate "86 St"
# stations spanning 21.8 km, and 38 names cover platforms more than a kilometre
# apart. Under complex_id no complex spans more than 0.44 km.
#
# The direction labels are editorial — they cannot be derived from coordinates,
# and a coordinate rule gets borough wrong anyway, since Inwood-207 St sits
# north and east of Bronx stations because the border is the Harlem River.
#
# Keyed on gtfs_stop_id, which matches our parent station IDs exactly: 496
# records against 496 stations, with no id in either set missing from the other.
STATIONS_URL="https://data.ny.gov/resource/39hk-dx4f.json?\$limit=1000&\$select=gtfs_stop_id,complex_id,borough,daytime_routes,north_direction_label,south_direction_label"
STATIONS_OUT="$(dirname "$0")/../public/stations.json"

# Street entrances and exits. Keyed on complex_id rather than gtfs_stop_id on
# purpose: three rows carry a compound id ("A32; D20", "A12; D13", "718; R09")
# for entrances shared between two stations, which an equality join on the stop
# id drops without a word — taking Times Sq's 7 platform, Union Sq, Fulton St
# and both Broadway Junctions with them. By complex the join is 445 of 445.
# It is also the truthful level: an entrance serves a complex, not a platform.
ENTRANCES_URL="https://data.ny.gov/resource/i9wp-a4ja.json?\$limit=5000&\$select=complex_id,entrance_type,entry_allowed,exit_allowed,entrance_latitude,entrance_longitude"
ENTRANCES_OUT="$(dirname "$0")/../public/entrances.json"

# `mktemp -d` with no template is the one form both GNU and BSD accept: GNU
# rejects a -t template without at least three X's, BSD treats it as a prefix.
# The trap cleans up even when curl or unzip fails partway.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
TMP_ZIP="$TMP_DIR/gtfs-subway.zip"

force=0
[[ "${1:-}" == "--force" ]] && force=1

mkdir -p "$OUT_DIR"

if [[ $force -eq 0 ]]; then
    missing=0
    for f in "${FILES[@]}"; do
        # -s: present AND non-empty. A truncated download should re-fetch.
        [[ -s "$OUT_DIR/$f" ]] || missing=1
    done
    [[ -s "$STATIONS_OUT" ]] || missing=1
    [[ -s "$ENTRANCES_OUT" ]] || missing=1
    if [[ $missing -eq 0 ]]; then
        echo "Static data already present — skipping download (--force to refresh)"
        exit 0
    fi
fi

echo "Downloading GTFS static data..."
curl -fsSL "$GTFS_URL" -o "$TMP_ZIP"

echo "Extracting..."
unzip -o "$TMP_ZIP" "${FILES[@]}" -d "$OUT_DIR"

# unzip preserves the archive's stored mode, which is 600 in MTA's ZIP. These
# are static assets that get copied into dist/ and served, so pin them readable
# rather than depending on whatever the upstream archive happens to carry.
chmod 644 "$OUT_DIR"/*.txt

# Fail loudly rather than leaving a half-populated directory behind.
for f in "${FILES[@]}"; do
    if [[ ! -s "$OUT_DIR/$f" ]]; then
        echo "ERROR: $f missing or empty after extraction" >&2
        exit 1
    fi
done

echo "Downloading station metadata..."
TMP_STATIONS="$TMP_DIR/stations.json"
curl -fsSL "$STATIONS_URL" -o "$TMP_STATIONS"

# The portal answers 200 with an error object when a query is malformed, so
# check the shape rather than the status code. Anything short of the full
# station list means the app would silently lose direction labels for whichever
# stations went missing — the same class of failure as the GTFS one above.
count="$(node -e '
  const rows = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(rows)) { console.error("not a JSON array"); process.exit(1); }
  process.stdout.write(String(rows.length));
' "$TMP_STATIONS")"

if [[ "$count" -lt 490 ]]; then
    echo "ERROR: station metadata has only $count records, expected ~496" >&2
    exit 1
fi

mv "$TMP_STATIONS" "$STATIONS_OUT"
chmod 644 "$STATIONS_OUT"

echo "Downloading station entrances..."
TMP_ENTRANCES="$TMP_DIR/entrances.json"
curl -fsSL "$ENTRANCES_URL" -o "$TMP_ENTRANCES"

# Trimmed here rather than in the app: the portal ships fifteen fields per row
# and the map needs five. Same shape check as above, since the portal answers
# 200 with an error object for a malformed query.
ecount="$(node -e '
  const fs = require("fs");
  const rows = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(rows)) { console.error("not a JSON array"); process.exit(1); }
  const out = rows
    .filter(r => r.entrance_latitude && r.entrance_longitude && r.complex_id)
    .map(r => ({
        c: r.complex_id,
        y: Number(Number(r.entrance_latitude).toFixed(6)),
        x: Number(Number(r.entrance_longitude).toFixed(6)),
        t: r.entrance_type ?? "",
        i: r.entry_allowed === "YES" ? 1 : 0,
        o: r.exit_allowed === "YES" ? 1 : 0,
    }));
  fs.writeFileSync(process.argv[2], JSON.stringify(out));
  process.stdout.write(out.length + " " + new Set(out.map(r => r.c)).size);
' "$TMP_ENTRANCES" "$TMP_ENTRANCES.trim")"

ecomplexes="${ecount##* }"
ecount="${ecount%% *}"

if [[ "$ecount" -lt 2000 ]]; then
    echo "ERROR: entrance data has only $ecount records, expected ~2120" >&2
    exit 1
fi

# The complex count is the assertion that matters, not the row count: the whole
# reason this joins on complex_id is that it reaches every complex where a join
# on gtfs_stop_id reaches 485 of 496 stations. A drop here means stations would
# quietly show no entrances at all.
if [[ "$ecomplexes" -lt 440 ]]; then
    echo "ERROR: entrances cover only $ecomplexes complexes, expected ~445" >&2
    exit 1
fi

mv "$TMP_ENTRANCES.trim" "$ENTRANCES_OUT"
chmod 644 "$ENTRANCES_OUT"

echo "Done — $count stations, $ecount entrances across $ecomplexes complexes, GTFS files in $OUT_DIR"
