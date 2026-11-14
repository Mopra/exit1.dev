#!/usr/bin/env bash
# Moves the exit1 runner to its own user (exit1run) behind kernel egress rules.
# Background and day to day use: README.md next to this file.
#
# Run as the deploy user (agent, needs passwordless sudo), from this folder:
#   ./runner-user.sh setup      user, nft rules, PM2 daemon. No downtime, safe to rerun.
#   ./runner-user.sh test       prove the rules as exit1run. No downtime.
#   ./runner-user.sh cutover    move the runner over, inside deploy mode (about a minute).
#   ./runner-user.sh rollback   move the runner back under the deploy user's PM2.
#   ./runner-user.sh status     where the runner runs and what the rules refused.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_USER=exit1run
RUN_HOME=/var/lib/exit1run
RUN_PM2_HOME="$RUN_HOME/.pm2"
RUN_PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
REPO=/opt/exit1/repo
PROC=exit1-vps-runner
ECOSYSTEM="$REPO/vps/ecosystem.config.cjs"
DEPLOY_MODE="$REPO/vps/scripts/deploy-mode.mjs"
HEALTH_URL="${HEALTH_URL:-http://localhost:3100/health}"
SECRETS=("$REPO/vps/.env" /opt/exit1/service-account.json)
DATA_DIRS=(/var/lib/exit1 /var/log/exit1)
WRAPPER=/usr/local/bin/pm2-runner
DEPLOY_USER="$(id -un)"

export PATH="$PATH:/usr/local/bin"
PM2_BIN="$(readlink -f "$(command -v pm2)")"

[ "$DEPLOY_USER" != root ] || { echo "Run as the deploy user (agent), not root." >&2; exit 2; }

as_runner() { (cd / && sudo -n -H -u "$RUN_USER" env PM2_HOME="$RUN_PM2_HOME" PATH="$RUN_PATH" "$@"); }
runner_pm2() { as_runner "$PM2_BIN" "$@"; }
refused() { sudo -n nft list chain inet exit1_runner refuse | grep -oP 'counter packets \K[0-9]+'; }
# has_proc <jlist output>: is the runner in that PM2 list?
has_proc() { case "$1" in *"\"name\":\"$PROC\""*) return 0 ;; *) return 1 ;; esac; }
runner_has_proc() { local l; l="$(runner_pm2 jlist 2>/dev/null || true)"; has_proc "$l"; }
deploy_has_proc() { local l; l="$(pm2 jlist 2>/dev/null || true)"; has_proc "$l"; }

grant_secrets() {
  for f in "${SECRETS[@]}"; do
    sudo -n chgrp "$RUN_USER" "$f"
    sudo -n chmod 640 "$f"
  done
}

install_templated() { # src dest mode
  sed "s#@PM2_BIN@#$PM2_BIN#g" "$1" | sudo -n tee "$2" >/dev/null
  sudo -n chmod "$3" "$2"
}

wait_healthy() {
  local deadline=$((SECONDS + 90))
  while [ $SECONDS -lt $deadline ]; do
    if curl -sf --max-time 5 "$HEALTH_URL" | grep -q '"status":"ok"'; then return 0; fi
    sleep 3
  done
  return 1
}

cmd_setup() {
  echo "--- user $RUN_USER ---"
  if ! id "$RUN_USER" >/dev/null 2>&1; then
    sudo -n useradd --system --create-home --home-dir "$RUN_HOME" --shell /usr/sbin/nologin "$RUN_USER"
  fi
  sudo -n chmod 750 "$RUN_HOME"
  id "$RUN_USER"

  echo "--- secrets readable by group $RUN_USER ---"
  grant_secrets
  ls -l "${SECRETS[@]}"
  for f in "${SECRETS[@]}"; do
    as_runner test -r "$f" || { echo "!!! $RUN_USER can not read $f" >&2; exit 1; }
  done
  as_runner test -r "$REPO/vps/lib/runner.js" || { echo "!!! $RUN_USER can not read the built runner" >&2; exit 1; }

  echo "--- nft rules ---"
  sudo -n install -d -m 755 /etc/exit1
  sudo -n install -m 644 "$HERE/runner-egress.nft" /etc/exit1/runner-egress.nft
  sudo -n nft -c -f /etc/exit1/runner-egress.nft
  sudo -n install -m 644 "$HERE/exit1-runner-egress.service" /etc/systemd/system/exit1-runner-egress.service
  sudo -n systemctl daemon-reload
  sudo -n systemctl enable exit1-runner-egress.service
  # The file replaces the table in one transaction, so a reload leaves no gap.
  if systemctl is-active --quiet exit1-runner-egress.service; then
    sudo -n systemctl reload exit1-runner-egress.service
  else
    sudo -n systemctl start exit1-runner-egress.service
  fi
  sudo -n nft list chain inet exit1_runner output

  echo "--- PM2 daemon for $RUN_USER ---"
  install_templated "$HERE/pm2-exit1run.service" /etc/systemd/system/pm2-exit1run.service 644
  sudo -n systemctl daemon-reload
  if runner_has_proc; then
    echo "The runner already runs under $RUN_USER, leaving its PM2 alone."
  elif ! systemctl is-active --quiet pm2-exit1run.service; then
    # First run: bring a daemon up by hand to install log rotation and write an
    # empty dump, then hand it to systemd so it gets the unit's limits.
    runner_pm2 ping >/dev/null
    if [ "$(as_runner sh -c "test -d $RUN_PM2_HOME/modules/pm2-logrotate && echo yes || echo no")" = no ]; then
      runner_pm2 install pm2-logrotate
    fi
    runner_pm2 set pm2-logrotate:max_size 50M
    runner_pm2 set pm2-logrotate:retain 7
    runner_pm2 set pm2-logrotate:compress true
    runner_pm2 set pm2-logrotate:dateFormat YYYY-MM-DD_HH-mm-ss
    runner_pm2 set pm2-logrotate:workerInterval 30
    runner_pm2 set pm2-logrotate:rotateInterval '0 0 * * *'
    runner_pm2 set pm2-logrotate:rotateModule true
    runner_pm2 save --force
    runner_pm2 kill
    sudo -n systemctl enable pm2-exit1run.service
    sudo -n systemctl start pm2-exit1run.service
  fi
  systemctl is-active pm2-exit1run.service

  echo "--- needrestart: never auto-restart this PM2 ---"
  if [ -d /etc/needrestart/conf.d ]; then
    printf '%s\n' \
      '# Never auto-restart the runner PM2 after a library update (same reason as 60-pm2-agent.conf).' \
      '$nrconf{override_rc}{qr(^pm2-exit1run\.service$)} = 0;' \
      | sudo -n tee /etc/needrestart/conf.d/60-pm2-exit1run.conf >/dev/null
  fi

  echo ""
  echo "Setup done. Next: ./runner-user.sh test, then ./runner-user.sh cutover"
}

# check <allow|connect|refuse> <label> <command to run as exit1run>
#   allow    the command succeeds
#   connect  the connection gets through (curl exit is neither 7 nor 28)
#   refuse   the command fails and the refuse counter goes up
# The counter is shared with the live runner once it runs as exit1run, so only
# the refuse checks lean on it.
check() {
  local want="$1" label="$2"
  shift 2
  local before after rc=0 ok=false
  before=$(refused)
  as_runner "$@" >/dev/null 2>&1 || rc=$?
  after=$(refused)
  case "$want" in
    allow)   if [ $rc -eq 0 ]; then ok=true; fi ;;
    connect) if [ $rc -ne 7 ] && [ $rc -ne 28 ]; then ok=true; fi ;;
    refuse)  if [ "$after" -gt "$before" ] && [ $rc -ne 0 ]; then ok=true; fi ;;
  esac
  if [ "$ok" = true ]; then
    echo "ok    $want  $label"
  else
    echo "FAIL  wanted $want  $label (rc=$rc, refused counter $before -> $after)"
    FAILS=$((FAILS + 1))
  fi
}

cmd_test() {
  FAILS=0
  local ip4 ip6
  ip4=$(ip -4 route get 1.1.1.1 | grep -oP 'src \K\S+')
  ip6=$(ip -6 route get 2606:4700:4700::1111 2>/dev/null | grep -oP 'src \K\S+' || true)
  echo "own addresses: $ip4 ${ip6:-none}"

  check allow "health port 127.0.0.1:3100" curl -sf -m 5 http://127.0.0.1:3100/health
  check allow "unbound 127.0.0.1:53" node -e 'const r=new (require("dns").promises.Resolver)();r.setServers(["127.0.0.1"]);r.resolve4("example.com").then(()=>process.exit(0),()=>process.exit(1))'
  check allow "resolved stub 127.0.0.53:53" getent hosts example.com
  check allow "public HTTPS" curl -sf -m 10 -o /dev/null https://example.com
  check allow "public ping" ping -c 1 -W 3 1.1.1.1
  check connect "own address $ip4:443" curl -sk -m 5 -o /dev/null "https://$ip4/"
  if [ -n "$ip6" ]; then check connect "own address [$ip6]:443" curl -sk -m 5 -o /dev/null "https://[$ip6]/"; fi

  check refuse "loopback ssh 127.0.0.1:22" curl -s -m 3 http://127.0.0.1:22/
  check refuse "other loopback address 127.0.0.2:3100" curl -s -m 3 http://127.0.0.2:3100/health
  check refuse "port 53 on a loopback address that is no resolver" curl -s -m 3 http://127.0.0.9:53/
  check refuse "metadata 169.254.169.254" curl -s -m 3 http://169.254.169.254/
  check refuse "private 10.0.0.1:3100" curl -s -m 3 http://10.0.0.1:3100/health
  check refuse "private 172.17.0.1" curl -s -m 3 http://172.17.0.1/
  check refuse "private 192.168.1.1" curl -s -m 3 http://192.168.1.1/
  check refuse "CGNAT 100.64.0.1" curl -s -m 3 http://100.64.0.1/
  check refuse "IPv6 loopback [::1]:3100" curl -s -m 3 'http://[::1]:3100/health'
  check refuse "IPv6 unique local" curl -s -m 3 'http://[fd00::1]/'
  check refuse "own address $ip4:22" curl -s -m 3 "http://$ip4:22/"
  check refuse "own address $ip4:3100" curl -s -m 3 "http://$ip4:3100/health"
  check refuse "own address $ip4:5432" curl -s -m 3 "http://$ip4:5432/"
  check refuse "own address $ip4:6379" curl -s -m 3 "http://$ip4:6379/"
  if [ -n "$ip6" ]; then check refuse "own address [$ip6]:22" curl -s -m 3 "http://[$ip6]:22/"; fi
  check refuse "ping loopback" ping -c 1 -W 2 127.0.0.1
  check refuse "udp to private 10.0.0.1:161" node -e 'const s=require("dgram").createSocket("udp4");s.on("error",()=>process.exit(1));s.connect(161,"10.0.0.1",()=>{s.send("x",e=>process.exit(e?1:0))});setTimeout(()=>process.exit(1),1500)'

  # The rules must not touch any other user.
  local rc=0
  curl -s -m 3 -o /dev/null http://127.0.0.1:22/ || rc=$?
  if [ $rc -ne 7 ]; then
    echo "ok    $DEPLOY_USER is not filtered"
  else
    echo "FAIL  $DEPLOY_USER got refused on loopback"
    FAILS=$((FAILS + 1))
  fi

  echo ""
  if [ "$FAILS" -eq 0 ]; then echo "All checks passed."; else echo "$FAILS check(s) FAILED."; exit 1; fi
}

DM_HELD=false
SWITCHING=false
dm_cleanup() {
  local rc=$?
  set +e
  if [ "$SWITCHING" = true ]; then
    # Died half way through a cutover: put the runner back where it was.
    SWITCHING=false
    echo "--- cutover failed (exit $rc), rolling back to $DEPLOY_USER ---"
    tail -n 30 /var/log/exit1/error.log
    to_deploy_user
    wait_healthy || echo "!!! Runner not healthy after rollback either. Check: pm2 logs $PROC"
  fi
  if [ "$DM_HELD" = true ]; then
    echo "--- lifting deploy mode (exit $rc) ---"
    node "$DEPLOY_MODE" disable || echo "!!! COULD NOT LIFT DEPLOY MODE. Run: node $DEPLOY_MODE disable"
  fi
  exit $rc
}

dm_enable() {
  trap dm_cleanup EXIT
  if node "$DEPLOY_MODE" status >/dev/null 2>&1; then
    echo "!!! Deploy mode is already active (another deploy running?). Try again when it is off." >&2
    exit 1
  fi
  # Held from before the write: an interrupt during its 35 s wait must still lift it.
  DM_HELD=true
  node "$DEPLOY_MODE" enable 10 "$1"
}

dm_disable() {
  node "$DEPLOY_MODE" disable
  if node "$DEPLOY_MODE" status >/dev/null 2>&1; then
    echo "!!! Deploy mode still active after disable." >&2
    exit 1
  fi
  DM_HELD=false
  echo "[deploy-mode] Confirmed inactive."
}

to_deploy_user() {
  runner_pm2 delete "$PROC" 2>/dev/null || true
  runner_pm2 save --force || true
  sudo -n chown -R "$DEPLOY_USER:$DEPLOY_USER" "${DATA_DIRS[@]}"
  if [ -e "$WRAPPER" ]; then sudo -n mv "$WRAPPER" "$WRAPPER.disabled"; fi
  if ! deploy_has_proc; then (cd "$REPO/vps" && pm2 start "$ECOSYSTEM"); fi
  pm2 save --force
}

cmd_cutover() {
  systemctl is-active --quiet pm2-exit1run.service || { echo "Run setup first." >&2; exit 1; }
  sudo -n nft list table inet exit1_runner >/dev/null || { echo "Egress rules are not loaded. Run setup first." >&2; exit 1; }
  if runner_has_proc; then echo "Runner is already under $RUN_USER."; exit 0; fi
  deploy_has_proc || { echo "No $PROC under $DEPLOY_USER's PM2 to move." >&2; exit 1; }
  grant_secrets

  # deploy.sh picks pm2-runner once the wrapper exists. Install it first, while
  # the wrapper is not there yet, so a deploy never meets a half switched box.
  if ! cmp -s "$HERE/deploy.sh" /opt/exit1/deploy.sh; then
    cp -p /opt/exit1/deploy.sh "/opt/exit1/deploy.sh.bak-$(date +%Y%m%d)"
    install -m 755 "$HERE/deploy.sh" /opt/exit1/deploy.sh
  fi

  dm_enable "runner user switch"
  # From here on any failure rolls back in dm_cleanup.
  SWITCHING=true

  echo "--- stopping the runner under $DEPLOY_USER ---"
  pm2 delete "$PROC"
  pm2 save --force

  echo "--- handing data and log folders to $RUN_USER ---"
  sudo -n chown -R "$RUN_USER:$DEPLOY_USER" "${DATA_DIRS[@]}"
  sudo -n chmod -R g+rwX "${DATA_DIRS[@]}"
  # setgid on the folders: files the runner creates keep the deploy user's group.
  sudo -n find "${DATA_DIRS[@]}" -type d -exec chmod g+s {} +

  echo "--- starting the runner under $RUN_USER ---"
  install_templated "$HERE/pm2-runner" "$WRAPPER" 755
  sudo -n rm -f "$WRAPPER.disabled"
  "$WRAPPER" start "$ECOSYSTEM"
  "$WRAPPER" save --force

  if ! wait_healthy; then
    echo "!!! Runner not healthy under $RUN_USER."
    exit 1
  fi
  SWITCHING=false
  curl -sf --max-time 5 "$HEALTH_URL" | head -c 300 || true
  echo
  dm_disable
  echo ""
  echo "Cutover done. The runner now runs as $RUN_USER. Use pm2-runner for it."
}

cmd_rollback() {
  if deploy_has_proc; then echo "Runner is already under $DEPLOY_USER."; exit 0; fi
  dm_enable "runner user rollback"
  to_deploy_user
  wait_healthy || { echo "!!! Runner not healthy after rollback. Check: pm2 logs $PROC" >&2; exit 1; }
  dm_disable
  echo "Rolled back. The runner runs as $DEPLOY_USER again. The egress rules stay loaded but match nothing."
}

cmd_status() {
  local pid
  pid=$(pgrep -f "lib/runner.js" | head -1 || true)
  if [ -n "$pid" ]; then echo "runner pid $pid runs as: $(ps -o user= -p "$pid")"; else echo "runner process not found"; fi
  systemctl is-active exit1-runner-egress.service pm2-exit1run.service || true
  sudo -n nft list chain inet exit1_runner refuse 2>/dev/null || echo "egress rules NOT loaded"
  sudo -n journalctl -k --since "-1 day" --no-pager 2>/dev/null | grep "exit1-runner-egress" | tail -n 10 || true
}

case "${1:-}" in
  setup) cmd_setup ;;
  test) cmd_test ;;
  cutover) cmd_cutover ;;
  rollback) cmd_rollback ;;
  status) cmd_status ;;
  *) sed -n '2,10p' "$0"; exit 2 ;;
esac
