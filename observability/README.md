# OpenCMO observability

OpenCMO includes a native analytics view at `/advanced` and a Prometheus endpoint at `/metrics`. Grafana is optional: the application remains fully usable without these containers.

Start OpenCMO, Prometheus, and Grafana:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml --profile observability up -d
```

Open:

- OpenCMO: <http://127.0.0.1:3000/advanced>
- Grafana: <http://127.0.0.1:3001/d/opencmo-marketing>
- Prometheus: <http://127.0.0.1:9090>

Anonymous access is limited to `Viewer`, and every port binds to localhost. The Grafana admin password defaults to `opencmo`; set `GRAFANA_ADMIN_PASSWORD` before starting the stack to change it.

The dashboard is provisioned automatically from `grafana/dashboards/opencmo-dashboard.json`. Prometheus keeps 90 days of samples. Metrics contain project IDs/names and aggregates only; prompts, content bodies, API keys, URLs, and buyer questions are never exported.
