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
- Backend `GET /api/oc-planner/bot-alerts` to fetch the latest saved OC planner snapshot

It then filters the returned planner to the player who owns the API key. The userscript loads on Torn's `factions.php` page, but the panel only activates on the faction organized crimes tab.
