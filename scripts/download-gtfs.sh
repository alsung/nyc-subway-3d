#!/usr/bin/env bash
# Downloads the MTA GTFS static ZIP and extracts the four files the app needs
# into public/gtfs/. Run once before npm run dev to use real route data.
set -euo pipefail

GTFS_URL="http://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip"
OUT_DIR="$(dirname "$0")/../public/gtfs"
TMP_ZIP="/tmp/gtfs-subway.zip"

mkdir -p "$OUT_DIR"

echo "Downloading GTFS static data..."
curl -fsSL "$GTFS_URL" -o "$TMP_ZIP"

echo "Extracting..."
unzip -o "$TMP_ZIP" stops.txt routes.txt shapes.txt trips.txt -d "$OUT_DIR"

rm "$TMP_ZIP"
echo "Done — files in $OUT_DIR"
