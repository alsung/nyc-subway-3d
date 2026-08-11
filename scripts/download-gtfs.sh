#!/usr/bin/env bash
# Downloads the MTA GTFS static ZIP and extracts the four files the app needs
# into public/gtfs/.
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
    if [[ $missing -eq 0 ]]; then
        echo "GTFS static data already present in $OUT_DIR — skipping download (--force to refresh)"
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

echo "Done — files in $OUT_DIR"
