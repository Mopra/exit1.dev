#!/usr/bin/env bash
# Writes what the runner egress rules look like right now to a file the runner
# can read. Installed as /usr/local/sbin/exit1-egress-status and run as root by
# exit1-egress-status.timer every 10 minutes.
#
# Why a file: reading nftables needs root and the runner (exit1run) has none.
# The runner's daily egressWatch job (vps/src/egress-watch.ts) reads this file
# and mails when the rules are not loaded or packets were refused.
#
#   exit1-egress-status              write /run/exit1-egress/status
#   exit1-egress-status credit <n>   mark n refused packets as made by
#                                    `runner-user.sh test`, then write the status
#
# Both folders are owned by root, so the runner can read the status but not
# fake it.
set -uo pipefail
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
umask 022

DIR=/run/exit1-egress
STATUS="$DIR/status"
KEEP=/var/lib/exit1-egress
STATE="$KEEP/state"
RUN_USER=exit1run
TABLE="inet exit1_runner"

[ "$(id -u)" -eq 0 ] || { echo "Run as root." >&2; exit 2; }

credit=0
if [ "${1:-}" = credit ]; then
  credit="${2:-}"
  case "$credit" in ''|*[!0-9]*) echo "usage: $0 credit <count>" >&2; exit 2 ;; esac
elif [ $# -gt 0 ]; then
  echo "usage: $0 [credit <count>]" >&2
  exit 2
fi

install -d -m 755 "$DIR" "$KEEP"
# One at a time: the timer and a `credit` call share the state file.
exec 9>"$KEEP/lock"
flock 9

num() { case "$1" in ''|*[!0-9]*) echo 0 ;; *) echo "$1" ;; esac; }

# shellcheck disable=SC2086
handle=$(nft -a list table $TABLE 2>/dev/null | sed -n '1s/.*# handle \([0-9][0-9]*\).*/\1/p')
# shellcheck disable=SC2086
out_chain="$(nft list chain $TABLE output 2>/dev/null || true)"
# shellcheck disable=SC2086
refuse_chain="$(nft list chain $TABLE refuse 2>/dev/null || true)"
uid="$(id -u "$RUN_USER" 2>/dev/null || true)"

# Loaded means: the table hooks into output, sends the runner user's packets to
# the runner chain, and the refuse chain still counts and rejects.
loaded=0
if [ -n "$uid" ] \
  && grep -q 'hook output' <<<"$out_chain" \
  && grep -Eq "meta skuid (\"?$RUN_USER\"?|$uid) jump runner" <<<"$out_chain" \
  && grep -q 'counter packets' <<<"$refuse_chain" \
  && grep -q 'reject' <<<"$refuse_chain"; then
  loaded=1
fi

refused="$(sed -n 's/.*counter packets \([0-9][0-9]*\).*/\1/p' <<<"$refuse_chain" | head -n 1)"

# The kernel counter starts at 0 again after a boot and after every reload of
# the rules (the rules file deletes the table and makes it anew, which gives it
# a new handle). So keep a total here that only grows: boot id plus table handle
# names one life of the counter, and each run adds what that life gained.
# What is lost: packets refused between the last run and a reboot (10 minutes
# at most). `runner-user.sh setup` runs this right before it reloads.
epoch="$(cat /proc/sys/kernel/random/boot_id):${handle:-none}"
s_epoch=""; s_last=0; s_total=0; s_tests=0
if [ -r "$STATE" ]; then read -r s_epoch s_last s_total s_tests < "$STATE" || true; fi
s_last=$(num "$s_last"); s_total=$(num "$s_total"); s_tests=$(num "$s_tests")

if [ -n "$refused" ]; then
  if [ "$s_epoch" = "$epoch" ] && [ "$refused" -ge "$s_last" ]; then
    s_total=$((s_total + refused - s_last))
  else
    s_total=$((s_total + refused))
  fi
  s_epoch="$epoch"
  s_last="$refused"
fi
s_tests=$((s_tests + credit))

echo "${s_epoch:-none} $s_last $s_total $s_tests" > "$STATE.tmp"
mv -f "$STATE.tmp" "$STATE"

{
  echo "checkedAt=$(date +%s)"
  echo "loaded=$loaded"
  echo "refused=$refused"
  echo "total=$s_total"
  echo "testTotal=$s_tests"
  # The rules log at most 6 refused packets a minute, so this is a sample.
  journalctl -k --utc -o short-iso --since "-25 hours" --no-pager 2>/dev/null \
    | grep 'exit1-runner-egress: ' | tail -n 20 | sed 's/^/log=/' || true
} > "$STATUS.tmp"
chmod 644 "$STATUS.tmp"
mv -f "$STATUS.tmp" "$STATUS"
