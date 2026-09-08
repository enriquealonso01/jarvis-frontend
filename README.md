# JARVIS frontend

The frontend for **JARVIS** — Enrique's personal + professional agent — and the
backend routes that power its **Control Center**. A downstream customization of
[NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT;
see `LICENSE` and `NOTICE`).

Live at **https://jarvis.enriquecodes.com** (served by `hermes-dashboard.service`
on the NetCup box).

## What's here
```
web/                          Vite 8 + React 19 + TS 6 + Tailwind 4 dashboard (JARVIS-customised)
  src/pages/ControlCenterPage.tsx   the redesigned Control Center (3D map, glass HUD, voice, current work)
  src/components/KnowledgeMap.tsx    hand-rolled 3D knowledge-map canvas engine
  src/pages/control-center.css       scoped Control Center styles (LENS_0 "Hermes Teal")
  src/lib/api.ts                     API client (control endpoints + types)
apps/shared/                  @hermes/shared — build dependency of web/ (kept in sync with upstream)
hermes_cli/
  web_routers/control_center.py   Control Center backend: overview, vitals, automations, attention,
                                   knowledge_graph, spend, zai_usage, activity, voice, per-task chat
  dashboard_auth/, web_server.py  dashboard auth + serving customizations
gateway/run.py, plugins/dashboard_auth/basic/   gateway + auth-plugin touchpoints
jarvis/graph/                 build_graph.py + registry.json — builds the knowledge-map aggregate
scripts/deploy.sh             build + deploy to the box
docs/DEPLOY.md                deploy + upstream-sync notes
```

## Build
```bash
cd web && npm install && npm run build   # → hermes_cli/web_dist (served by the dashboard)
npm run typecheck                        # tsc --noEmit
```
`web/` depends on the sibling `apps/shared` (`@hermes/shared`, a `file:` dep), so keep them together.

## Deploy
See `docs/DEPLOY.md`. In short: `scripts/deploy.sh` copies the tracked frontend +
backend files to the box, rebuilds `web_dist`, and restarts `hermes-dashboard`
(with a backup for rollback).

## Data endpoints (Control Center)
`/api/control/{overview,vitals,automations,attention,knowledge_graph,spend,zai_usage,activity}`
and `POST /api/control/work/{id}/chat`. Vitals read `/proc`; automations read
`~/.hermes/jarvis/automations.json`; the knowledge map reads the aggregate built
by `jarvis/graph/build_graph.py`.

## Upstream
This is a snapshot fork at hermes-agent commit `63279301`. To pull upstream
changes, add the remote and merge the `web/` + `apps/shared` trees by hand:
```bash
git remote add upstream https://github.com/NousResearch/hermes-agent.git
git fetch upstream
```
