# Local observability configuration

This directory contains local-only Prometheus scrape/rule configuration and a
provisioned Grafana dashboard. It does not deploy or configure a hosted
observability service.

The default targets are the API on `8787`, orchestrator on `8788`, and worker
operational endpoint on `8790`. When Prometheus runs outside Docker, replace
`host.docker.internal` with the appropriate loopback or host address.

`/metrics` requires the deployment's operations token, because it exposes
per-route request counts, worker load and workflow run totals. The token is
derived from `BEAM_STUDIO_SECRET_KEY`, so there is no separate secret to
distribute and rotating that key rotates this with it. Write it to a file
Prometheus can read:

```bash
node -e 'const {createHmac}=require("node:crypto");
  process.stdout.write(createHmac("sha256", process.env.BEAM_STUDIO_SECRET_KEY)
    .update("beam-studio.ops.v1").digest("base64url"))' > ops-token
```

and mount it at `/etc/prometheus/ops-token`, which is where the scrape jobs
look. A scraper running inside the service container does not need it:
loopback callers are exempt so container healthchecks keep working.

Mount the files as follows in an existing local Prometheus/Grafana stack:

- `prometheus/prometheus.yml` -> `/etc/prometheus/prometheus.yml`
- `prometheus/beam-alerts.yml` -> `/etc/prometheus/rules/beam-alerts.yml`
- `grafana/provisioning` -> `/etc/grafana/provisioning`
- `grafana/dashboards` -> `/var/lib/grafana/dashboards`

Prometheus can validate the configuration with `promtool check config` and
`promtool check rules` when `promtool` is installed. No hosted exporter or
credential is required.
