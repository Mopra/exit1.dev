#!/usr/bin/env bash
set -euo pipefail

# exit1 VPS runner deploy.
#
# Deploy mode is a GLOBAL Firestore flag (system_settings/deploy_mode) that makes
# every runner in the fleet skip scheduled checks. Restarting a runner without it
# drops checks on the floor and can emit false-down alerts, so this script always
# pauses the fleet around the restart.
#
# Ordering matters: pull + build run BEFORE the pause, so the slow npm ci/build
# happens while monitoring is still live. The pause covers only the restart.
#
# Single box:
#   ./deploy.sh
#
# Fleet rollout (run from Frankfurt, then Boston):
#   ./deploy.sh --hold          # region 1: pauses, deploys, LEAVES the pause on
#   ssh boston /opt/exit1/deploy.sh   # region 2: reuses the live pause, lifts it at the end
#
# The --hold window auto-expires (see HOLD_MINUTES) as a safety net, so a
# forgotten second region self-heals instead of leaving monitoring paused.
#
# Flags:
#   --hold              leave deploy mode active on success (first region of a fleet rollout)
#   --no-deploy-mode    do not touch deploy mode at all (you are managing it by hand)
#
# Env overrides: DEPLOY_MODE_MINUTES, HOLD_MINUTES, PM2, HEALTH_URL

REPO="/opt/exit1/repo"
SSH_KEY="$HOME/.ssh/exit1_deploy"
# The runner lives in its own PM2 daemon as user exit1run (kernel egress
# backstop, see vps/ops/README.md). pm2-runner is the wrapper that talks to it.
# Boxes not yet switched fall back to the plain pm2 of the deploying user.
if [ -z "${PM2:-}" ]; then
  if [ -x /usr/local/bin/pm2-runner ]; then PM2=/usr/local/bin/pm2-runner; else PM2="$(command -v pm2)"; fi
fi
PROC="exit1-vps-runner"
DEPLOY_MODE="$REPO/vps/scripts/deploy-mode.mjs"
HEALTH_URL="${HEALTH_URL:-http://localhost:3100/health}"
DEPLOY_MODE_MINUTES="${DEPLOY_MODE_MINUTES:-10}"
HOLD_MINUTES="${HOLD_MINUTES:-25}"
HEALTH_TIMEOUT=90

HOLD=false
USE_DEPLOY_MODE=true
for arg in "$@"; do
  case "$arg" in
    --hold)           HOLD=true ;;
    --no-deploy-mode) USE_DEPLOY_MODE=false ;;
    -h|--help)        sed -n '3,30p' "$0"; exit 0 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

# Tracks whether WE are responsible for lifting the pause. Set once enabled (or
# once we adopt an already-active window), cleared after a successful disable.
DEPLOY_MODE_HELD=false

dm() { node "$DEPLOY_MODE" "$@"; }

# status uses a PREDICATE exit code: active -> 0, inactive -> 1. A healthy
# "Inactive" therefore looks like a failure to set -e; always test it with `if`.
dm_active() { node "$DEPLOY_MODE" status >/dev/null 2>&1; }

cleanup() {
  local rc=$?
  if [ "$DEPLOY_MODE_HELD" = true ]; then
    if [ $rc -eq 0 ] && [ "$HOLD" = true ]; then
      echo ""
      echo "!!! Deploy mode is STILL ACTIVE (--hold): the fleet is not monitoring."
      echo "!!! Deploy the next region now, or lift it with:"
      echo "!!!   node $DEPLOY_MODE disable"
      echo "!!! It auto-expires in ${HOLD_MINUTES}m regardless."
    else
      echo ""
      echo "--- Deploy failed (exit $rc), lifting deploy mode ---"
      dm disable || echo "!!! COULD NOT LIFT DEPLOY MODE. Run: node $DEPLOY_MODE disable"
    fi
  fi
  exit $rc
}
trap cleanup EXIT

echo "=== exit1 deploy ==="
date -u '+%Y-%m-%d %H:%M:%S UTC'
echo "region: ${VPS_REGION_ID:-$(grep -hoP '^VPS_REGION_ID=\K.*' "$REPO/vps/.env" 2>/dev/null || echo unknown)}"

# ---------------------------------------------------------------------------
# Build first. Monitoring stays live for this part.
# ---------------------------------------------------------------------------
echo ""
echo "--- Pulling latest ---"
cd "$REPO"
BEFORE=$(git rev-parse --short HEAD)
GIT_SSH_COMMAND="ssh -i $SSH_KEY -o StrictHostKeyChecking=no" git pull origin master
AFTER=$(git rev-parse --short HEAD)
echo "HEAD: $BEFORE -> $AFTER"

echo ""
echo "--- Building functions ---"
cd "$REPO/functions"
npm ci --silent
npm run build

echo ""
echo "--- Building VPS runner ---"
cd "$REPO/vps"
npm ci --silent
npm run build

# ---------------------------------------------------------------------------
# Pause the fleet, restart, verify, resume.
# ---------------------------------------------------------------------------
if [ "$USE_DEPLOY_MODE" = true ]; then
  echo ""
  echo "--- Deploy mode ---"
  if dm_active; then
    # Another region is mid-rollout and already paused the fleet. Adopt that
    # window: no second write, and no 35s propagation wait (already propagated).
    echo "[deploy-mode] Already active (held by another region), adopting it."
    dm status || true
    DEPLOY_MODE_HELD=true
  else
    MINUTES="$DEPLOY_MODE_MINUTES"
    [ "$HOLD" = true ] && MINUTES="$HOLD_MINUTES"
    # If this write fails we must NOT restart: monitoring is still live.
    dm enable "$MINUTES" "vps-deploy $AFTER"
    DEPLOY_MODE_HELD=true
  fi
else
  echo ""
  echo "--- Deploy mode: SKIPPED (--no-deploy-mode) ---"
fi

echo ""
echo "--- Restarting runner ---"
$PM2 restart "$PROC" --update-env

echo ""
echo "--- Verifying ---"
deadline=$((SECONDS + HEALTH_TIMEOUT))
healthy=false
while [ $SECONDS -lt $deadline ]; do
  state=$($PM2 jlist 2>/dev/null \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const p=JSON.parse(s).find(x=>x.name===process.argv[1]);console.log(p?p.pm2_env.status:"missing")}catch{console.log("unknown")}})' "$PROC")
  if [ "$state" = "online" ] && curl -sf --max-time 5 "$HEALTH_URL" | grep -q '"status":"ok"'; then
    healthy=true
    break
  fi
  sleep 3
done

if [ "$healthy" != true ]; then
  echo "!!! Runner did not report healthy within ${HEALTH_TIMEOUT}s (pm2 status: ${state:-unknown})"
  echo "!!! Check: $PM2 logs $PROC --err --lines 50"
  exit 1
fi

curl -sf --max-time 5 "$HEALTH_URL" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const d=JSON.parse(s);console.log(`health: status=${d.status} region=${d.region} uptime=${d.uptimeSeconds}s dueNow=${d.schedule.dueNow}`)})'
$PM2 describe "$PROC" | grep -E 'status|restarts' | head -3

if [ "$USE_DEPLOY_MODE" = true ] && [ "$HOLD" != true ]; then
  echo ""
  echo "--- Lifting deploy mode ---"
  dm disable
  # Only drop our responsibility once it is provably off. If it still reports
  # active, leave DEPLOY_MODE_HELD set so the EXIT trap retries the disable.
  if dm_active; then
    echo "!!! Deploy mode still reports ACTIVE after disable. Investigate."
    exit 1
  fi
  DEPLOY_MODE_HELD=false
  echo "[deploy-mode] Confirmed inactive. Checks resume within 30s."
  echo "[deploy-mode] cpm reads 0 for ~30-60s while the rolling window refills. Expected."
fi

echo ""
echo "=== Deploy complete ($BEFORE -> $AFTER) ==="
