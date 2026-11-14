# VPS ops: runner user and kernel egress rules

Box-level files for the two runner VPSes (`exit1-eu`, `exit1-us`). The copies on
the boxes are installed from here.

## What this is

The runner sends probes to whatever host a customer types in. The first line of
defence is the app-level guard in `functions/src/ssrf-guard.ts`. This folder is
the second line, in the kernel, for the day the first one has a hole.

- The runner runs as its own system user, `exit1run`, in its own PM2 daemon
  (`pm2-exit1run.service`, `PM2_HOME=/var/lib/exit1run/.pm2`).
- An nftables table, `inet exit1_runner`, checks every packet that user sends.

What `exit1run` may reach:

| Destination | Why |
| --- | --- |
| Any public IPv4 or IPv6 address | Probes, Firestore, BigQuery, webhooks |
| `127.0.0.1:53`, `127.0.0.53:53`, `127.0.0.54:53` | unbound and the systemd-resolved stub |
| `127.0.0.1:3100` | The runner's own health port |
| The box's own public address, TCP 443 only | Webhooks to `automation.exit1.dev` (hosted on the EU box) |

Everything else is refused: the rest of loopback, RFC 1918, CGNAT, link-local
and cloud metadata (`169.254.0.0/16`), multicast, reserved and documentation
ranges, all IPv6 outside `2000::/3`, Teredo, and every other port on the box's
own addresses (Postgres, Redis, SSH, Coolify, the Docker bridges).

Refused means rejected at once (TCP reset or ICMP prohibited), not silently
dropped, so a blocked probe fails fast and does not tie up a slot until timeout.

Replies to connections that come in to the runner (Caddy on US, Traefik on EU)
are not affected. No other user on the box is affected.

## Files

| File | Installed as |
| --- | --- |
| `runner-egress.nft` | `/etc/exit1/runner-egress.nft` |
| `exit1-runner-egress.service` | `/etc/systemd/system/`, loads the rules at boot |
| `pm2-exit1run.service` | `/etc/systemd/system/`, the runner's PM2 daemon |
| `pm2-runner` | `/usr/local/bin/pm2-runner`, pm2 for the runner |
| `deploy.sh` | `/opt/exit1/deploy.sh` |
| `runner-user.sh` | not installed, run from here |

## Day to day

Deploys are unchanged: `/opt/exit1/deploy.sh` as `agent`. It finds `pm2-runner`
by itself.

For anything else about the runner, use `pm2-runner` where you used `pm2`:

```
pm2-runner list
pm2-runner logs exit1-vps-runner --lines 50
```

Plain `pm2` as `agent` no longer shows the runner (on EU it still shows
`day3-worker`). Logs are still in `/var/log/exit1/`.

To restart the whole runner PM2 daemon, do it inside deploy mode:

```
node /opt/exit1/repo/vps/scripts/deploy-mode.mjs enable 5 "pm2 restart"
sudo systemctl restart pm2-exit1run
node /opt/exit1/repo/vps/scripts/deploy-mode.mjs disable
```

The runner reads `/opt/exit1/repo/vps/.env` and `/opt/exit1/service-account.json`
through the group `exit1run` (mode 640, owner still `agent`). `pm2-runner` puts
that back on every call, so after editing `.env` a normal deploy is enough.

## Checking the rules

```
cd /opt/exit1/repo/vps/ops
./runner-user.sh status     # who runs the runner, the refuse counter, last log lines
./runner-user.sh test       # tries allowed and refused targets as exit1run
```

Refused packets are counted in the `refuse` chain and logged to the kernel log
with the prefix `exit1-runner-egress:` (at most 6 lines a minute):

```
sudo nft list chain inet exit1_runner refuse
sudo journalctl -k | grep exit1-runner-egress
```

A count that keeps rising means something got past the app-level guard. Look at
the logged destination and fix the guard.

## Changing the rules

Edit `runner-egress.nft`, keep `blocked4` in step with the list in
`functions/src/ssrf-guard.ts`, then on each box after a pull:

```
cd /opt/exit1/repo/vps/ops && ./runner-user.sh setup && ./runner-user.sh test
```

`setup` is safe to rerun. It reloads the rules in one transaction, with no gap
and no runner restart.

Do not enable `nftables.service` on these boxes. `/etc/nftables.conf` starts with
`flush ruleset`, which would wipe the Docker and ufw rules. The runner table is
its own table and is loaded by `exit1-runner-egress.service`.

If the rules fail to load at boot the runner still starts (the unit is `Wants`,
not `Requires`), so monitoring keeps running on the app-level guard alone.
`./runner-user.sh status` shows "egress rules NOT loaded" in that case.

## Setting up a new box, or going back

```
./runner-user.sh setup      # user, rules, PM2 daemon. No downtime.
./runner-user.sh test
./runner-user.sh cutover    # moves the runner, inside deploy mode. About a minute.
./runner-user.sh rollback   # back under agent's PM2, inside deploy mode.
```

`cutover` rolls back by itself if the runner does not come up healthy.
