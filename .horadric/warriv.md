# Warriv's memory

## Rules
- Functions deploys use `npm run deploy:changed`, never a full `firebase deploy --only functions`.
- Alert/check code runs on the VPS: changes there need a VPS rebuild in both regions, before hosting.
- No session can post to Discord: customer replies there are the human's. `quest blocked` only works on a quest a session holds.
- npm and MCP registry publishes need the human's npm login: sessions bump, test and push exit1-mcp, then stop; the human publishes the newest version.
- A session that stops while its own long background job runs (deploy:changed --all, a timed pilot) is waiting, not stalled: check its last note, leave it, do not re-file.
- A timed quest ("after <date>") checked off before its date with no result is not done: file a fresh one when the date comes.

## Lately
- 2026-10-23 Round (hourly, first after 04:00, at 12d2e6d): the day was clean (3 quests done, nothing repeated). The day gave 2 lore notes (Twilio sender pool after the Danish number's release; the human's WhatsApp choices). Noted on the WhatsApp quest the after-go-live email to BE/JP users. Nothing else to do.
- 2026-10-23 Rounds (hourly, at d8f28d1, cd3e405 and 5896aef): nothing to do. WhatsApp go-live still with the human; cold-start re-measure waits until 2026-10-26; no aim open.
- 2026-10-23 Round (hourly): cold-start follow-up is truly done (cause agent-signup eager imports, fix 225f8ad deployed, local load CPU halved). Live after-numbers owed: re-measure on or after 2026-10-26. WhatsApp still with the human.
- 2026-10-22 Round (human left): nothing to do. Cold-start follow-up is in progress; WhatsApp go-live waits on the human; no aim open.
- 2026-10-22 Round (hourly): cold-start re-measure is really done (badge, day3webhook about 2x faster; mcpoauth 3291 to 5677 ms, publicapi 3106 to 4644 ms slower). Filed a follow-up quest to confirm with medians and fix (Model: sonnet). WhatsApp go-live still with the human.
- 2026-10-22 Woken for [!] WhatsApp go-live: rightly with the human (Meta accounts, payment, token). Noted, gave Model: sonnet. Also filed the overdue cold-start re-measure (Model: haiku), date passed.
- 2026-10-13 Round (hourly, first after 04:00): look back found 4 silent stops on the lazy-load quest, all waits on its own --all deploy (it landed); wrote a rule, no quest. The re-measure quest is [x] with no result before its 2026-10-19 date: noted it, will file a fresh one then.
- 2026-10-13 Rounds (hourly, eleven more, latest at 64c9eb8): nothing to do. 16 done, 0 open, no aim; only the cold-start re-measure waits on its timer (2026-10-19).
- 2026-10-13 Round (human left): nothing to do. MCP registry now lists exit1-mcp 0.4.0 as latest, so that Open item is closed. Only the cold-start re-measure waits on its timer (2026-10-19); no aim open.
- 2026-10-12 Round (hourly): nothing to do. Only the cold-start re-measure waits on its own timer (2026-10-19); no aim open.
- 2026-10-12 Woken: log stalled, only the cold-start re-measure waits on its timer (2026-10-19). Lazy-load rollout quest is [x]; npm now has exit1-mcp 0.4.0. No aim open, nothing to do.
- 2026-10-12 Woken for the lazy-load quest: pilot cut badge startup 3390 to 1368 ms, full deploy:changed --all running since 21:12Z; session just waits on it, not blocked. Noted, left it. Woken a second time (batch 1 of 13, session counts 128 functions): same, noted the count to check. Third wake (batch 7 of 13): same, noted. Fourth wake (batch 11 of 13, 1 to 10 clean): same, noted.
- 2026-10-12 Woken for the [!] JSON docs quest: found npm at 0.3.1 (human published), MCP registry still 0.2.0, repo at 0.4.0. Noted: human publishes 0.4.0 to npm and the registry.
- 2026-10-12 Rounds (hourly and human-left, many, latest a human-left round at 49c9510): nothing to do. Lazy-load pilot is [!] on its own timer until 2026-10-13 ~02:52Z, then its session compares cold starts and rolls out; npm publish of exit1-mcp 0.3.1 waits on the human; no aim open. Folded six identical lines into this one.
- 2026-10-12 Round (human left again): nothing to do. Only the [!] npm publish of exit1-mcp 0.3.1 waits on the human; no aim open.
- 2026-10-12 Round (hourly): nothing to do. Team-members commits (5ef01ce, 4d8d206) are the human's own work, not a quest; only the [!] npm publish of exit1-mcp 0.3.1 waits on the human; no aim open.
- 2026-10-12 Woken for the [!] JSON docs quest again: nothing new, already with the human (publish exit1-mcp 0.3.1 only). Left it.
- 2026-10-12 Round (human left, first after 04:00): the day was clean (0 quests done, nothing repeated). Nothing to do; only the [!] npm publish of exit1-mcp 0.3.1 waits on the human; no aim open.
- 2026-10-11 Round (hourly, several more, latest this evening): nothing to do. Only the [!] npm publish of exit1-mcp 0.3.1 waits on the human; no aim open.
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
- WhatsApp go-live: waits on the human for Meta setup + approved templates, then token + phone number ID. Resume the quest when they come. Once live: file a quest to email the Belgian and Japanese users a WhatsApp how-to (human's wish), and later compare WhatsApp vs SMS usage.
- On or after 2026-10-26: file a quest to re-run `node scripts/cold-start-report.mjs 3` for live mcpoauth/publicapi after-numbers following 225f8ad (Model: haiku).
