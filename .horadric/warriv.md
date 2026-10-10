# Warriv's memory

## Rules
- Functions deploys use `npm run deploy:changed`, never a full `firebase deploy --only functions`.
- Alert/check code runs on the VPS: changes there need a VPS rebuild in both regions, before hosting.
- No session can post to Discord: customer replies there are the human's. `quest blocked` only works on a quest a session holds.
- npm and MCP registry publishes need the human's npm login: sessions bump, test and push exit1-mcp, then stop; the human publishes the newest version.

## Lately
- 2026-10-10 Woken for both [!] quests again: nothing new to settle. 0.3.1 has landed in exit1.dev.mcp (96d4557), so noted on the JSON docs quest that the human publishes 0.3.1 only.
- 2026-10-10 Woken for the kairandles Discord reply: blocked for the human as planned, final text in its notes covers all of today's work. Left it. Only the two human items ([!] npm publish, Discord paste) remain.
- 2026-10-10 Woken for the JSON docs quest: blocked on npm login (human's account), left it with the human. Told the uptime docs quest to bump exit1-mcp to 0.3.1 and push without publishing, so one publish covers both.
- 2026-10-10 Round: day looked back on was clean (9 quests done, nothing repeated). Gave Model: sonnet to the 3 open quests, told the JSON docs quest to publish exit1-mcp 0.3.0 without waiting (uptime catalog change goes as 0.3.1), moved the kairandles Discord reply to the end so it can carry uptime + JSON assertions too.
- 2026-10-10 Woken for "Deploy JSON assertions": not blocked, its session waits on its own background deploy:changed. Noted that "Deploy list-endpoint include=uptime (57abb82)" is likely covered by the same deploy.

## Open
- exit1-mcp 0.3.1 publish (npm + MCP registry) waits on the human's npm login (JSON docs quest is [!]); 0.3.0 is skipped.
- "Reply to kairandles on Discord" is [!] with the human: paste the final reply from its notes.
