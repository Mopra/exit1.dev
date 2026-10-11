# Warriv's memory

## Rules
- Functions deploys use `npm run deploy:changed`, never a full `firebase deploy --only functions`.
- Alert/check code runs on the VPS: changes there need a VPS rebuild in both regions, before hosting.
- No session can post to Discord: customer replies there are the human's. `quest blocked` only works on a quest a session holds.
- npm and MCP registry publishes need the human's npm login: sessions bump, test and push exit1-mcp, then stop; the human publishes the newest version.

## Lately
- 2026-10-11 Round (hourly, several more): nothing to do. Only the [!] npm publish of exit1-mcp 0.3.1 waits on the human; no aim open.
- 2026-10-11 Round (hourly): nothing to do. Only the [!] npm publish of exit1-mcp 0.3.1 waits on the human; no aim open. Folded about 25 identical idle-round lines from 10-10 and 10-11 into this one.
- 2026-10-11 Woken for the [!] JSON docs quest again: nothing new, already with the human (publish exit1-mcp 0.3.1 only). Left it.
- 2026-10-11 Woken for the [!] JSON docs quest again (8 times today now): nothing new, already with the human (publish exit1-mcp 0.3.1 only). Left it.
- 2026-10-11 Round (hourly, first after 04:00): the day was clean (4 quests done, nothing repeated). Nothing to do; only the [!] npm publish of exit1-mcp 0.3.1 waits on the human; no aim open.
- 2026-10-10 Round: nothing to do. Discord reply to kairandles is done; only the [!] npm publish of exit1-mcp 0.3.1 waits on the human. No aim open.
- 2026-10-10 Round (human left): nothing to do. Only the two [!] human items remain (npm publish 0.3.1, Discord paste); no aim open, so no new quests.
- 2026-10-10 Woken for both [!] quests again: nothing new to settle. 0.3.1 has landed in exit1.dev.mcp (96d4557), so noted on the JSON docs quest that the human publishes 0.3.1 only.
- 2026-10-10 Woken for the kairandles Discord reply: blocked for the human as planned, final text in its notes covers all of today's work. Left it. Only the two human items ([!] npm publish, Discord paste) remain.
- 2026-10-10 Woken for the JSON docs quest: blocked on npm login (human's account), left it with the human. Told the uptime docs quest to bump exit1-mcp to 0.3.1 and push without publishing, so one publish covers both.
- 2026-10-10 Round: day looked back on was clean (9 quests done, nothing repeated). Gave Model: sonnet to the 3 open quests, told the JSON docs quest to publish exit1-mcp 0.3.0 without waiting (uptime catalog change goes as 0.3.1), moved the kairandles Discord reply to the end so it can carry uptime + JSON assertions too.
- 2026-10-10 Woken for "Deploy JSON assertions": not blocked, its session waits on its own background deploy:changed. Noted that "Deploy list-endpoint include=uptime (57abb82)" is likely covered by the same deploy.

## Open
- exit1-mcp 0.3.1 publish (npm + MCP registry) waits on the human's npm login (JSON docs quest is [!]); 0.3.0 is skipped.