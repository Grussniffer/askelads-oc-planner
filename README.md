# OC Planner Userscript

Tampermonkey userscript for showing each faction member their personal OC Planner recommendation inside Torn.

## Setup

1. Open `oc-planner-recommendations.user.js`.
2. Set `BACKEND_BASE_URL` to the deployed backend that runs `D:\Codex\Backend\Backend`.
3. Install the userscript in Tampermonkey.
4. Open `https://www.torn.com/factions.php?step=your&type=1#/tab=crimes`.
5. Paste a Torn API key into the OC Planner panel and press Refresh.

The script uses Tampermonkey HTTPS requests:

- Torn API `user/?selections=profile` to identify the player who owns the key
- Backend `GET /api/oc-planner/bot-alerts` to fetch the latest saved OC planner snapshot

It then filters the returned planner to the player who owns the API key. Tampermonkey loads the script on Torn's `factions.php` page, but the panel only activates on the faction organized crimes tab.

## Notes

- Players only need their Torn API key after `BACKEND_BASE_URL` has been set.
- The key is stored locally in Tampermonkey storage.
- After the first successful validation, the player's profile is cached locally so later visits can resume without an extra validation call.
- The key is sent to Torn's official API for profile lookup, but it is not sent to the OC Planner backend.
- The script auto-refreshes the cached plan every 5 minutes while Torn is open.
- The backend still controls all planner logic, CPR, assignments, and permissions.
- The script displays recommendations only. It does not click, join, submit, scrape hidden pages, bypass CAPTCHA, or automate Torn actions.

## Backend connection

Set `BACKEND_BASE_URL` to the backend origin, for example:

```js
const BACKEND_BASE_URL = "https://askelads.grusmedia.no";
```

The userscript fetches `/api/oc-planner/bot-alerts` automatically. If the panel says it cannot load the snapshot, check that:

- the DNS name resolves publicly
- HTTPS is working for the host
- the backend process is running the API server that registers `/api/oc-planner/bot-alerts`
- the endpoint is reachable from a browser
- `/api/*` is proxied to the Express backend, not served by the frontend app

For example, with nginx the API location needs to come before the frontend fallback:

```nginx
location /api/ {
    proxy_pass http://127.0.0.1:3000/api/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location / {
    proxy_pass http://127.0.0.1:3001;
}
```
