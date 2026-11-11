# OC Planner Userscript

Userscript for showing each faction member their personal OC Planner recommendation inside Torn. It can run in common userscript managers such as Tampermonkey, and includes fallbacks for Torn PDA.

## Setup

1. Install `oc-planner-recommendations.user.js` in your userscript manager.
2. Open `https://www.torn.com/factions.php?step=your&type=1#/tab=crimes`.
3. Expand the inline **OC Planner** section above the crimes, paste a Torn API key, and press Refresh.

## Torn PDA

The script should also work in Torn PDA. Add the raw userscript URL in Torn PDA's script settings and set the injection time to `END` / document end if Torn PDA asks for it:

```text
https://raw.githubusercontent.com/Grussniffer/askelads-oc-planner/main/oc-planner-recommendations.user.js
```

On Torn PDA, the script falls back to PDA's `PDA_httpGet`/`PDA_httpPost` helpers and browser `localStorage` when userscript-manager `GM_*` APIs are not available.

## Data requests

The script uses userscript HTTPS requests:

- Torn API `user/?selections=profile` to identify the player who owns the key
- Backend `GET /api/v1/factions/:factionId/oc-planner/bot-alerts` to fetch the latest complete-plan or CPR eligibility snapshot
- Backend `POST /api/v1/factions/:factionId/oc-planner/script-access` to record that this player checked the planner

It then filters the returned planner to the player who owns the API key. The check-in sends player id, player name, faction id, script version, and planner timestamp/run id. It does not send the Torn API key. The userscript loads on Torn's `factions.php` page, but the panel only activates on the faction organized crimes tab.

For faster startup, the script stores that player's filtered recommendations, CPR decisions, and role queue deadlines locally while checking the backend for an update. The cache is scoped to the API key, player, and faction. Normal refreshes send the saved snapshot revision, allowing the backend to return a compact unchanged response instead of the full faction plan. The script revalidates the player's current faction with Torn every 15 minutes, while the Refresh button always checks it immediately. The full faction planner is not added to this local cache.

Ready snapshots are checked every five minutes. Generating and failed snapshots retry after one minute, and returning to the browser tab does not issue another request when the latest check is still fresh. Script-access check-ins are limited to once every six hours unless the player, faction, script version, or planner run changes.

The planner is part of the OC page's normal layout, above the native crime list, not a floating or draggable box. It appears only on your faction's organized crimes tab and disappears when you navigate elsewhere, including in-page navigation. It waits for Torn's content to load and remounts if Torn replaces that content; it never falls back to a body overlay. Old saved drag positions are ignored. No extra Torn API calls are introduced by mounting or expanding the inline section.

The section remembers whether the player left it collapsed. When a saved key has no prior display preference, it starts as a full-width summary strip showing the next action. Use the title or expand button to open it (both also work with the keyboard). On mobile the section stays in the page flow and scrolls with the crimes, without covering join controls.

On Torn's OC list, each reserved assignment is labelled with the role and the OC it follows. The label changes when the exact role is opening, found, already joined, filled by another player, or missing. Hovering the label shows the exact OC id plus planned join and start times when available.

If the faction has no saved plan, the panel shows a neutral no-plan notice instead of an error or an older cached assignment. It continues checking automatically and will show recommendations after a faction planner admin generates a plan.

Faction admins can choose between complete-plan recommendations and CPR eligibility. In CPR mode, open role cards are green when the member's saved CPR fits the faction's band and red when it falls outside. Red cards explain the limit and block Join. Missing CPR or limits leave the card neutral. Green roles respect Torn's own button availability. Opening a grouped OC focuses its roles in yellow.

Each role uses its own impact category's saved CPR band. Near-zero role weights must remain known zero weights in backend metadata, rather than falling into the Unknown category. The userscript never overrides faction limits to make a high-CPR member eligible for a low-impact role. Exact bands such as 100–100 display `requires 100%`, rather than suggesting CPR above 100 is possible.

The **Queue full** rule takes priority over CPR and blocks Join when a matching open role has more planning ahead than the faction limit. Faction admins can set the limit in OC Planner settings. It defaults to 48 hours, and 0 turns off queue blocking. The script receives changes on its existing snapshot refresh. It updates joined work from the lineup and planning progress Torn displays in the foreground Crimes tab. If Torn's roster still shows the old lineup, reopen or refresh the Crimes tab. Incomplete lineup or progress data uses the saved queue. Complete plans also count future turns from the saved plan, excluding people already in the live lineup. Torn controls its own availability and handles every join. The role colors and Join rules add no requests.

Eligible green roles now show a short CPR explanation. A separate yellow warning marks an otherwise eligible role when the OC's already-joined members have more than 24 hours of planning remaining. Yellow remains joinable. Admins can adjust the warning threshold independently of the blocking limit, or set it to 0 to turn the warning off. Red CPR/queue restrictions take priority. Live joins, leaves and progress update both colors locally, and yellow clears at the threshold without a request. Scheduled future recommendations count toward the red queue rule, but not the yellow joined-planning warning.

Role footers show actual remaining joined-member planning in hours and minutes, for example `Joined planning left: 36h 20m`, alongside CPR or queue restrictions. The value uses readable live progress or the saved snapshot, updates in place each minute, and still appears when both color thresholds are off. Unknown progress is never displayed as zero. This is joined work remaining, not a promise the OC will start then: open roles must still be filled, and complete-plan queues can also include future scheduled members. No requests are made by the local timer.

Faction admins can also allow a queue exception, off by default. When there is no known eligible opening at or below the limit, Join can be used for an eligible long-queue role. The script checks the visible lineup and uses saved openings elsewhere on the board. In complete-plan mode it checks personal recommendations and eligible Any free slots. The exception clears as soon as another eligible opening becomes available, and never changes CPR eligibility or Torn's own Join restrictions.

CPR eligibility mode pauses complete-plan generation and scheduled optimizer refreshes. A separate lightweight OC and CPR snapshot refreshes every 30 minutes without running the assignment optimizer or replacing the last complete plan. While the first lightweight refresh is running, the userscript can temporarily use the last complete-plan snapshot and labels that fallback clearly.

Switching back to complete-plan mode starts a fresh backend generation immediately. Its generating, ready, stale, or failed state survives closing the admin page, and the userscript hides retained old assignments until the new plan has been saved.

Version 0.2.66 matches numbered roles (for example, Muscle #1 and Muscle #2) independently, falling back to generic role CPR only when that exact position is absent. The update rebuilds previously cached personal recommendations from the saved backend snapshot while retaining the cached Torn profile. No new Torn API calls are added.

## Tests

Run `pnpm install --frozen-lockfile`, `pnpm exec playwright install chromium`, then `pnpm test`. To use an installed Edge instead, set `PLAYWRIGHT_CHANNEL=msedge`. The browser tests run the installable userscript against local HTML fixtures with all requests mocked, including OC-only activation, SPA navigation, late/replaced content, keyboard/mobile layout, native role highlights, and request counts. They do not use a live Torn account or API key.
