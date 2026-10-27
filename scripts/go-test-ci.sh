#!/usr/bin/env bash
# Runs the API's Go tests the way CI does, then checks which tests skipped.
#
# A skipped test passes without testing anything, so the set of skips is held
# to api/testdata/allowed-skips.txt. REQUIRE_TEST_DB already turns a missing
# database into a failure; this catches the rest: a t.Skip left in while
# debugging, an environment check that is false in CI, or a fix that landed
# without un-skipping its test.
#
# The log stays readable: go test -json is replayed as the same lines -v
# prints, and the skip check runs even when tests fail.
set -uo pipefail

cd "$(dirname "$0")/../api"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

go test ./... -race -json > "$work/events.json"
status=$?

# fromjson? passes over anything that is not an event rather than aborting.
jq -Rj 'fromjson? | select(.Action == "output") | .Output' "$work/events.json"

jq -Rr 'fromjson? | select(.Action == "skip" and .Test != null) | .Test' "$work/events.json" \
    | sort -u > "$work/skipped"
sed -e 's/#.*//' -e 's/[[:space:]]*$//' -e '/^[[:space:]]*$/d' testdata/allowed-skips.txt \
    | sort -u > "$work/allowed"

unexpected=$(comm -23 "$work/skipped" "$work/allowed")
stale=$(comm -13 "$work/skipped" "$work/allowed")

echo
echo "Skipped: $(wc -l < "$work/skipped" | tr -d ' '), allowed: $(wc -l < "$work/allowed" | tr -d ' ')"
if [ -n "$unexpected" ]; then
    echo "::error::Tests skipped that are not in api/testdata/allowed-skips.txt:"
    echo "$unexpected" | sed 's/^/  /'
    status=1
fi
if [ -n "$stale" ]; then
    echo "::error::Listed in api/testdata/allowed-skips.txt but no longer skipped; delete these lines:"
    echo "$stale" | sed 's/^/  /'
    status=1
fi
exit $status
