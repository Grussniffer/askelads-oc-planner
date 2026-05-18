# OC Planner Userscript

Tampermonkey userscript for showing each faction member their personal OC Planner recommendation inside Torn.

## Setup

1. Open `oc-planner-recommendations.user.js`.
2. Set `BACKEND_BASE_URL` to the deployed backend
3. Install the userscript in Tampermonkey.
4. Open `https://www.torn.com/factions.php?step=your&type=1#/tab=crimes`.
5. Paste a Torn API key into the OC Planner panel and press Refresh.

The script uses Tampermonkey HTTPS requests:

- Torn API `user/?selections=profile` to identify the player who owns the key
- Backend `GET /api/oc-planner/bot-alerts` to fetch the latest saved OC planner snapshot

It then filters the returned planner to the player who owns the API key. Tampermonkey loads the script on Torn's `factions.php` page, but the panel only activates on the faction organized crimes tab.
