# Dashboards and alerting

The Go API exposes Prometheus metrics at `/metrics`. Fly scrapes that endpoint
automatically because `api/fly.toml` declares a `[metrics]` block, stores it in
their managed Prometheus, and exposes it through managed Grafana at
[fly-metrics.net](https://fly-metrics.net). Nothing here runs a Prometheus or a
Grafana of its own.

## Importing the dashboard

`nyc-subway-api.json` is the dashboard, kept here rather than only in Grafana so
that a panel change arrives as a diff.

1. Open [fly-metrics.net](https://fly-metrics.net) and sign in with your Fly account
2. **Dashboards → New → Import**
3. Upload `nyc-subway-api.json`
4. Pick **Prometheus on Fly** when prompted for a data source

Step 4 is why the JSON has a `datasource` template variable instead of a
hardcoded UID. Fly's data source UID is specific to an organization, so a
hardcoded one produces a dashboard of empty panels for anyone else who imports
it — including you, from a different org.

Re-importing over the same `uid` (`nyc-subway-api`) updates the existing
dashboard rather than creating a second copy.

## Why alerting is not in Grafana

Fly's managed Grafana draws dashboards but has no alerting. From their docs:

> Fly.io doesn't include built-in alerting on metrics, so you'll need to set up
> alerting yourself against the Prometheus endpoint.

So the rules live in `scripts/check-metrics.mjs` and run from
`.github/workflows/metrics-check.yml` every 30 minutes, querying Fly's
Prometheus HTTP API and opening a GitHub issue when something fires.

This is a fair trade. A threshold in a repository is reviewable in a pull
request and carries the reasoning for the number next to it; the same value
typed into a web form is neither. What it is not is a pager — GitHub's scheduled
runs drift and can be skipped entirely, so treat an issue timestamp as "no
earlier than" rather than "at".

## The rules

| Rule | Fires when | Why it is not obvious |
|---|---|---|
| `feed-stale` | A feed has not refreshed in 3 minutes | Last-known-good caching keeps serving riders, so a dead upstream is invisible |
| `feed-failing` | A feed is returning errors | Fires earlier than staleness, since failures retry every 30s |
| `alerts-unlabeled` | Under 80% of alerts carry a Mercury label | MTA's extension can stop parsing with nothing erroring; alerts just go generic |
| `metrics-absent` | The API reports no metrics at all | Every rule above is a threshold, and a threshold over a missing metric is silently satisfied |

That last one is the important one. `time() - feed_last_refresh > 180` returns
nothing when `feed_last_refresh` does not exist, which reads exactly like good
health. `absent()` is what notices the difference between "fine" and "gone".

## Running the checks locally

```bash
FLY_METRICS_TOKEN=... node scripts/check-metrics.mjs
```

Exits non-zero if any rule fires or any query fails.

## The token

CI uses `FLY_METRICS_TOKEN`, which is read-only and org-scoped — deliberately
not the `FLY_API_TOKEN` used to deploy. That one can destroy machines, and
reading a counter should not require it.

To create or rotate it, piped so the value is never displayed:

```bash
fly tokens create readonly -o personal | gh secret set FLY_METRICS_TOKEN
```

Read-only tokens authenticate as `Authorization: FlyV1 <token>` against
`https://api.fly.io/prometheus/<org>/api/v1/query`.
