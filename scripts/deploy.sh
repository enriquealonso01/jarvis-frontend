#!/usr/bin/env bash
# Deploy the JARVIS frontend + backend touchpoints to the box and rebuild.
# Usage: scripts/deploy.sh            (uses the `jarvis-netcup` SSH alias)
set -euo pipefail
BOX="${JARVIS_BOX:-jarvis-netcup}"
ROOT="/usr/local/lib/hermes-agent"
STAMP="$(date +%Y%m%d-%H%M%S)"
here="$(cd "$(dirname "$0")/.." && pwd)"

echo "→ backing up current web_dist + control_center.py on $BOX"
ssh "$BOX" "cd $ROOT && cp -r hermes_cli/web_dist hermes_cli/web_dist.bak-$STAMP && \
  cp hermes_cli/web_routers/control_center.py hermes_cli/web_routers/control_center.py.bak-$STAMP"

echo "→ syncing source (frontend + backend touchpoints)"
for p in web/src web/index.html web/package.json \
         hermes_cli/web_routers/control_center.py \
         hermes_cli/dashboard_auth hermes_cli/web_server.py \
         gateway/run.py plugins/dashboard_auth; do
  scp -q -r "$here/$p" "$BOX:$ROOT/$(dirname "$p")/" 2>/dev/null || \
    scp -q -r "$here/$p" "$BOX:$ROOT/$p"
done
scp -q "$here/jarvis/graph/build_graph.py" "$here/jarvis/graph/registry.json" "$BOX:/root/.hermes/jarvis/graph/" || true

echo "→ building web_dist on the box (Node 24)"
ssh "$BOX" "cd $ROOT/web && npm run build"

echo "→ restarting hermes-dashboard"
ssh "$BOX" "systemctl restart hermes-dashboard && sleep 3 && systemctl is-active hermes-dashboard"
echo "✓ deployed. Rollback: restore hermes_cli/web_dist.bak-$STAMP + control_center.py.bak-$STAMP and restart."
