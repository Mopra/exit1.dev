# Warriv's memory

## Rules
- Functions deploys use `npm run deploy:changed`, never a full `firebase deploy --only functions`.
- Alert/check code runs on the VPS: changes there need a VPS rebuild in both regions, before hosting.
- No session can post to Discord: customer replies there are the human's. `quest blocked` only works on a quest a session holds.

## Lately
- 2026-10-10 Round: day looked back on was clean (9 quests done, nothing repeated). Gave Model: sonnet to the 3 open quests, told the JSON docs quest to publish exit1-mcp 0.3.0 without waiting (uptime catalog change goes as 0.3.1), moved the kairandles Discord reply to the end so it can carry uptime + JSON assertions too.
- 2026-10-10 Woken for "Deploy JSON assertions": not blocked, its session waits on its own background deploy:changed. Noted that "Deploy list-endpoint include=uptime (57abb82)" is likely covered by the same deploy.

## Open
- Check "Deploy JSON assertions" closes clean; then "Deploy list-endpoint include=uptime" only needs a live smoke test.
- "Reply to kairandles on Discord" needs the human: a session that picks it should block itself; if it is still open with nothing else left, make sure the human sees it.
