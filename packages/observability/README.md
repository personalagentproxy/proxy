# @proxy/observability

How Personal Agent Proxy is watched: what the api and the web app log and measure, and where it
goes. A self-hosted server needs none of it: without the variables below, the api writes its log
to stdout alone, one JSON object per line, and sums its metrics up for nothing.

- `src/server.ts`: the server's logger. Stdout always, as text in development and as JSON lines in
  production; Grafana Cloud Loki in batches when set, labelled by service, env and level.
- `src/client.ts`: the web app's logger, posted to the api in batches, which writes it on as the
  web app's or the desktop app's (`packages/api/src/observability/client-logs.ts`).
- `src/metrics.ts`: counters, histograms and gauges, pushed to Grafana Cloud's OTLP gateway every
  half minute. On it `db-metrics.ts` (every query), `tool-metrics.ts` (every request of an agent),
  `agent-metrics.ts` (the built-in agent's jobs and every request of a model), and the probes
  `db-pool-probe.ts` (`SELECT 1` each second) and `job-queue-probe.ts` (the AgentJob queue).
- `src/slack.ts`: the Slack notifier the api posts sign-ups with, and the internal repo's admin
  Grafana's alerts.
- `src/loki-client.ts`: pushing lines to Loki, and querying it, as the admin does for an alert's
  thread.

The Grafana side of hosted Personal Agent Proxy, its dashboards, alert rules, saved queries and
the `obs` command that pushes and queries them, is in the internal repo, which takes this package
as a workspace.

## Variables

Hosted Personal Agent Proxy sets these on Render (`render.yaml`); each is documented with the rest
in `packages/api/src/utils/env-schema.ts`:

- `LOKI_URL`, `LOKI_USER_ID`, `GRAFANA_CLOUD_TOKEN`: the log to Loki.
- `METRICS_OTLP_URL`, `METRICS_USER_ID`, `GRAFANA_CLOUD_TOKEN`: the metrics to the OTLP gateway.
- `SLACK_BOT_TOKEN`, `SLACK_CHANNEL_SIGNUPS`: the sign-up notice. Grafana's alerts are the
  internal repo's admin's, at its `/alerts/grafana`.
