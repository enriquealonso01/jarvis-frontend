# Deploy & maintain

## Prerequisites
- SSH access to the box as the `jarvis-netcup` alias (root@159.195.245.62).
- Node 24 / npm are already on the box; the web app's `node_modules` is installed there.

## Deploy
From a checkout:
```bash
scripts/deploy.sh
```
This backs up the current `web_dist` + `control_center.py`, syncs the frontend +
backend touchpoints to `/usr/local/lib/hermes-agent`, runs `npm run build` on the
box (→ `hermes_cli/web_dist`), and restarts `hermes-dashboard`.

**Rollback** (if a deploy looks wrong):
```bash
ssh jarvis-netcup 'cd /usr/local/lib/hermes-agent && rm -rf hermes_cli/web_dist && \
  cp -r hermes_cli/web_dist.bak-<STAMP> hermes_cli/web_dist && \
  cp hermes_cli/web_routers/control_center.py.bak-<STAMP> hermes_cli/web_routers/control_center.py && \
  systemctl restart hermes-dashboard'
```

## Verify
- `systemctl status hermes-dashboard` active; `journalctl -u hermes-dashboard -f` clean.
- Open https://jarvis.enriquecodes.com — boot → Control Center; panels show live data.
- On the box: `venv/bin/python -c "…; control_center._vitals()"` etc. for endpoint spot-checks.

## Knowledge-map data
`jarvis/graph/build_graph.py` reads `~/.hermes/jarvis/graph/registry.json`, measures
real code metrics for repos with a live `path`, and writes `aggregate.json` (served by
`/api/control/knowledge_graph`). A daily cron (04:17) refreshes it. To add a repo or
mark one measured, edit `registry.json` (give it a `path`) and rerun the script.

## Automations
`/api/control/automations` reads `~/.hermes/jarvis/automations.json` — the editable
registry of non-system scheduled tasks (name, domain, cron, host, status). Edit it to
reflect the real jobs; next-run is computed from `cron`, status drives the badge/alerts.

## Upstream sync
This is a snapshot fork at hermes-agent `63279301`. To bring in upstream changes:
```bash
git remote add upstream https://github.com/NousResearch/hermes-agent.git
git fetch upstream
```
Then merge the `web/` and `apps/shared` trees by hand (our customizations live mostly
in `web/src/pages`, `web/src/components`, `web/src/lib/api.ts`, `web/src/themes`,
`web/src/i18n`, and `hermes_cli/`). Expect conflicts only in those paths.
