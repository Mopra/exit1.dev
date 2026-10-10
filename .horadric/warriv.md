# Warriv's memory

## Rules
- Functions deploys use `npm run deploy:changed`, never a full `firebase deploy --only functions`.
- Alert/check code runs on the VPS: changes there need a VPS rebuild in both regions, before hosting.

## Lately
- 2026-10-10 Woken for "Deploy JSON assertions": not blocked, its session waits on its own background deploy:changed. Noted that "Deploy list-endpoint include=uptime (57abb82)" is likely covered by the same deploy.

## Open
- Check "Deploy JSON assertions" closes clean; then "Deploy list-endpoint include=uptime" only needs a live smoke test.
