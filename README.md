# OC Planner Userscript

Userscript for showing each faction member their personal OC Planner recommendation inside Torn. It can run in common userscript managers such as Tampermonkey, and includes fallbacks for Torn PDA.

## Setup

1. Open `oc-planner-recommendations.user.js`.
2. Set `BACKEND_BASE_URL` to the deployed backend
3. Install the userscript in your userscript manager.
4. Open `https://www.torn.com/factions.php?step=your&type=1#/tab=crimes`.
5. Paste a Torn API key into the OC Planner panel and press Refresh.

## Torn PDA

The script should also work in Torn PDA. Add the raw userscript URL in Torn PDA's script settings and set the injection time to `END` / document end if Torn PDA asks for it:

```text
https://raw.githubusercontent.com/Grussniffer/askelads-oc-planner/main/oc-planner-recommendations.user.js
```

On Torn PDA, the script falls back to PDA's `PDA_httpGet`/`PDA_httpPost` helpers and browser `localStorage` when userscript-manager `GM_*` APIs are not available.

## Data requests

The script uses userscript HTTPS requests:

- Torn API `user/?selections=profile` to identify the player who owns the key
- Backend `GET /api/oc-planner/bot-alerts` to fetch the latest complete-plan or CPR eligibility snapshot
- Backend `POST /api/oc-planner/script-access` to record that this player checked the planner

It then filters the returned planner to the player who owns the API key. The check-in sends player id, player name, faction id, script version, and planner timestamp/run id. It does not send the Torn API key. The userscript loads on Torn's `factions.php` page, but the panel only activates on the faction organized crimes tab.

For faster startup, the script stores only that player's filtered recommendation locally and shows it while checking the backend for an update. The cache is scoped to the API key, player, and faction. The script revalidates the player's current faction with Torn at least every five minutes, and the Refresh button always checks it immediately. The full faction planner is not added to this local cache.

On Torn's OC list, each reserved assignment is labelled with the role and the OC it follows. The label changes when the exact role is opening, found, already joined, filled by another player, or missing. Hovering the label shows the exact OC id plus planned join and start times when available.

If the faction has no saved plan, the panel shows a neutral no-plan notice instead of an error or an older cached assignment. It continues checking automatically and will show recommendations after a faction planner admin generates a plan.

Faction admins can choose between complete-plan recommendations and CPR eligibility. In CPR mode, the panel groups recruiting roles by OC where the player's role-specific CPR is inclusively inside the saved minimum and maximum requirement. Opening one of those OCs highlights every exact eligible role shown on its row. These roles are labelled as eligible rather than assigned or reserved; the userscript remains advisory and does not enforce Torn joins.

CPR eligibility mode pauses complete-plan generation and scheduled optimizer refreshes. A separate lightweight OC and CPR snapshot refreshes every 30 minutes without running the assignment optimizer or replacing the last complete plan. While the first lightweight refresh is running, the userscript can temporarily use the last complete-plan snapshot and labels that fallback clearly.

Switching back to complete-plan mode starts a fresh backend generation immediately. Its generating, ready, stale, or failed state survives closing the admin page, and the userscript hides retained old assignments until the new plan has been saved.
