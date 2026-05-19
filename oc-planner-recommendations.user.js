// ==UserScript==
// @name         AskeLadds OC Planner Recommendations
// @namespace    https://askeladds.local/oc-planner
// @version      0.2.21
// @description  Shows your OC Planner recommendation on Torn's faction OC page.
// @author       AskeLadds
// @downloadURL  https://raw.githubusercontent.com/Grussniffer/askelads-oc-planner/main/oc-planner-recommendations.user.js
// @updateURL    https://raw.githubusercontent.com/Grussniffer/askelads-oc-planner/main/oc-planner-recommendations.meta.js
// @match        https://www.torn.com/factions.php*
// @match        https://torn.com/factions.php*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @connect      api.torn.com
// @connect      askelads.grusmedia.no
// @noframes
// ==/UserScript==

(() => {
	"use strict";

	/*
	 * Set this once before sharing the userscript.
	 * Players should only need to enter their Torn API key in the panel.
	 *
	 * Examples:
	 *   const BACKEND_BASE_URL = "https://askelads.grusmedia.no";
	 *   const BACKEND_BASE_URL = "http://localhost:3000";
	 */
	const BACKEND_BASE_URL = "https://askelads.grusmedia.no";

	const STORAGE_KEY = "askeladds_oc_planner_api_key";
	const PROFILE_STORAGE_KEY = "askeladds_oc_planner_profile";
	const COLLAPSED_STORAGE_KEY = "askeladds_oc_planner_collapsed";
	const PANEL_ID = "askeladds-oc-planner-panel";
	const REQUEST_TIMEOUT_MS = 60000;
	const AUTO_REFRESH_MS = 5 * 60 * 1000;
	const STALE_PLANNER_SECONDS = 15 * 60;
	const isTornPda =
		typeof window.PDA_httpGet === "function" ||
		typeof window.PDA_httpPost === "function";

	const storage = {
		get(key, fallback = "") {
			if (typeof GM_getValue === "function") return GM_getValue(key, fallback);
			const value = window.localStorage?.getItem(key);
			return value === null || value === undefined ? fallback : value;
		},
		set(key, value) {
			if (typeof GM_setValue === "function") {
				GM_setValue(key, value);
				return;
			}
			window.localStorage?.setItem(key, String(value));
		},
		remove(key) {
			if (typeof GM_deleteValue === "function") {
				GM_deleteValue(key);
				return;
			}
			window.localStorage?.removeItem(key);
		},
	};

	const addStyle = (css) => {
		if (typeof GM_addStyle === "function") {
			GM_addStyle(css);
			return;
		}
		const style = document.createElement("style");
		style.textContent = css;
		(document.head || document.documentElement).appendChild(style);
	};

	const registerMenuCommand = (name, callback) => {
		if (typeof GM_registerMenuCommand === "function") {
			GM_registerMenuCommand(name, callback);
		}
	};

	const state = {
		profile: null,
		lastPlanner: null,
		lastPayload: null,
		loading: false,
		error: "",
		progress: "",
		autoRefreshTimer: undefined,
		active: false,
		collapsed: String(storage.get(COLLAPSED_STORAGE_KEY, "") || "") === "1",
		disclosureOpen: false,
		pendingHighlight: null,
		lastHighlightRecommendation: null,
		highlightObserver: null,
		highlightRetryQueued: false,
	};

	let lastRenderedMarkup = "";

	addStyle(`
		#${PANEL_ID} {
			position: fixed;
			right: 14px;
			bottom: 14px;
			z-index: 999999;
			width: min(340px, calc(100vw - 28px));
			max-height: calc(100vh - 28px);
			font: 12px/1.35 Arial, Helvetica, sans-serif;
			color: #e7ecf3;
			background: #111820;
			border: 1px solid #2d3b4b;
			box-shadow: 0 12px 36px rgba(0, 0, 0, 0.42);
		}
		#${PANEL_ID}.collapsed .ocp-body {
			display: none;
		}
		#${PANEL_ID} * {
			box-sizing: border-box;
		}
		#${PANEL_ID} button,
		#${PANEL_ID} input {
			font: inherit;
		}
		#${PANEL_ID} .ocp-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 6px;
			padding: 7px 8px;
			background: #1a2530;
			border-bottom: 1px solid #2d3b4b;
			cursor: pointer;
			user-select: none;
			touch-action: manipulation;
		}
		#${PANEL_ID} .ocp-title {
			font-weight: 700;
			font-size: 13px;
			letter-spacing: 0;
		}
		#${PANEL_ID} .ocp-actions {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		#${PANEL_ID} .ocp-highlight-again {
			padding: 4px 6px;
			font-weight: 700;
			line-height: 1;
		}
		#${PANEL_ID} .ocp-icon-button,
		#${PANEL_ID} .ocp-button {
			border: 1px solid #3a4b5c;
			background: #223040;
			color: #e7ecf3;
			cursor: pointer;
		}
		#${PANEL_ID} .ocp-icon-button {
			width: 24px;
			height: 24px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 0;
		}
		#${PANEL_ID} .ocp-button {
			padding: 5px 7px;
		}
		#${PANEL_ID} .ocp-icon-button:hover,
		#${PANEL_ID} .ocp-button:hover {
			background: #2c3c4f;
		}
		#${PANEL_ID} .ocp-button.primary {
			border-color: #5284c7;
			background: #285582;
		}
		#${PANEL_ID} .ocp-button.danger {
			border-color: #8a3e45;
			background: #51252b;
		}
		#${PANEL_ID} .ocp-body {
			padding: 8px;
			max-height: calc(100vh - 64px);
			overflow-y: auto;
			overscroll-behavior: contain;
		}
		#${PANEL_ID} .ocp-row {
			display: flex;
			gap: 5px;
			margin-top: 6px;
		}
		#${PANEL_ID} .ocp-row input {
			min-width: 0;
			flex: 1;
		}
		#${PANEL_ID} .ocp-input {
			width: 100%;
			border: 1px solid #354454;
			background: #0d131a;
			color: #e7ecf3;
			padding: 6px;
		}
		#${PANEL_ID} .ocp-muted {
			color: #a8b3c0;
		}
		#${PANEL_ID} .ocp-error {
			margin-top: 6px;
			color: #ffd5d5;
			background: #3b171c;
			border: 1px solid #75303a;
			padding: 6px;
		}
		#${PANEL_ID} .ocp-status {
			margin-top: 6px;
			color: #b9d8ff;
		}
		#${PANEL_ID} .ocp-status-line {
			display: flex;
			align-items: center;
			flex-wrap: wrap;
			gap: 4px 6px;
			margin-top: 6px;
		}
		#${PANEL_ID} .ocp-pill {
			display: inline-flex;
			align-items: center;
			border: 1px solid #456178;
			background: #182536;
			color: #b9d8ff;
			padding: 2px 5px;
			font-size: 11px;
		}
		#${PANEL_ID} .ocp-pill.stale {
			border-color: #aa8f53;
			background: #2a2416;
			color: #ffe3a6;
		}
		#${PANEL_ID} .ocp-card {
			margin-top: 7px;
			padding: 7px;
			border: 1px solid #344353;
			background: #151e28;
		}
		#${PANEL_ID} .ocp-card.next {
			border-color: #70a66d;
			background: #15251d;
		}
		#${PANEL_ID} .ocp-card-link {
			display: inline-flex;
			align-items: center;
			justify-content: center;
			margin-top: 6px;
			width: 100%;
			border: 1px solid #82b77b;
			background: #264d2e;
			color: #f2fff1;
			padding: 6px 7px;
			text-decoration: none;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-card-link:hover {
			background: #32633b;
		}
		.askeladds-oc-planner-highlight {
			outline: 3px solid #82d173 !important;
			box-shadow: 0 0 0 3px rgba(130, 209, 115, 0.28), 0 0 18px rgba(130, 209, 115, 0.55) !important;
		}
		.askeladds-oc-planner-role-highlight {
			outline: 3px solid #ffd166 !important;
			box-shadow: 0 0 0 3px rgba(255, 209, 102, 0.26), 0 0 18px rgba(255, 209, 102, 0.5) !important;
		}
		#${PANEL_ID} .ocp-card.need-more {
			border-color: #aa8f53;
			background: #2a2416;
		}
		#${PANEL_ID} .ocp-card-title {
			font-weight: 700;
			font-size: 13px;
			margin-bottom: 3px;
		}
		#${PANEL_ID} .ocp-card-heading {
			display: flex;
			flex-wrap: wrap;
			align-items: baseline;
			gap: 2px 6px;
		}
		#${PANEL_ID} .ocp-card-heading .ocp-muted {
			overflow-wrap: anywhere;
		}
		#${PANEL_ID} .ocp-grid {
			display: grid;
			grid-template-columns: 1fr 1fr;
			gap: 2px 8px;
			margin-top: 5px;
		}
		#${PANEL_ID} .ocp-label {
			color: #a8b3c0;
		}
		#${PANEL_ID} .ocp-value {
			text-align: right;
			overflow-wrap: anywhere;
		}
		#${PANEL_ID} .ocp-stat-row {
			display: flex;
			flex-wrap: wrap;
			gap: 3px 8px;
			margin-top: 4px;
		}
		#${PANEL_ID} .ocp-stat {
			display: inline-flex;
			gap: 3px;
			min-width: 0;
			white-space: normal;
		}
		#${PANEL_ID} .ocp-stat-label {
			color: #a8b3c0;
			flex: 0 0 auto;
		}
		#${PANEL_ID} .ocp-stat-value {
			color: #e7ecf3;
			overflow-wrap: anywhere;
		}
		#${PANEL_ID} .ocp-footer {
			margin-top: 6px;
			font-size: 12px;
			color: #9ba8b7;
		}
		#${PANEL_ID} .ocp-team {
			margin-top: 6px;
			border-top: 1px solid #2f3d4d;
			padding-top: 5px;
		}
		#${PANEL_ID} .ocp-team-title {
			color: #a8b3c0;
			font-weight: 700;
			margin-bottom: 3px;
		}
		#${PANEL_ID} .ocp-team-chips {
			display: flex;
			flex-wrap: wrap;
			gap: 4px;
		}
		#${PANEL_ID} .ocp-team-chip {
			display: inline-flex;
			gap: 3px;
			max-width: 100%;
			border: 1px solid #354454;
			background: #101820;
			padding: 2px 5px;
		}
		#${PANEL_ID} .ocp-team-chip.you {
			border-color: #70a66d;
			background: #172719;
		}
		#${PANEL_ID} .ocp-chip-slot {
			color: #a8b3c0;
			flex: 0 0 auto;
		}
		#${PANEL_ID} .ocp-chip-member {
			color: #e7ecf3;
			overflow-wrap: anywhere;
		}
		#${PANEL_ID} .ocp-team-chip.you .ocp-chip-member {
			color: #b7f5b1;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-disclosure {
			margin-top: 8px;
			border: 1px solid #718095;
			background: #f4f7fb;
			color: #17202b;
		}
		#${PANEL_ID} .ocp-disclosure summary {
			cursor: pointer;
			padding: 8px;
			color: #111820;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-disclosure table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
			background: #ffffff;
		}
		#${PANEL_ID} .ocp-disclosure th,
		#${PANEL_ID} .ocp-disclosure td {
			border-top: 1px solid #d3dbe6;
			padding: 6px;
			text-align: left;
			vertical-align: top;
			color: #17202b;
		}
		#${PANEL_ID} .ocp-disclosure th {
			width: 38%;
			color: #354255;
			font-weight: 700;
		}
		@media (max-width: 520px) {
			#${PANEL_ID} {
				right: 8px;
				bottom: 8px;
				width: calc(100vw - 16px);
				max-height: min(60vh, calc(100vh - 16px));
				font-size: 11px;
			}
			#${PANEL_ID}.collapsed {
				width: min(210px, calc(100vw - 16px));
			}
			#${PANEL_ID} .ocp-header {
				min-height: 44px;
				padding: 8px 10px;
			}
			#${PANEL_ID} .ocp-icon-button {
				width: 34px;
				height: 34px;
				font-size: 18px;
			}
			#${PANEL_ID} .ocp-body {
				padding: 8px;
				max-height: calc(min(60vh, 100vh - 16px) - 39px);
			}
			#${PANEL_ID} .ocp-row {
				gap: 5px;
				margin-top: 6px;
			}
			#${PANEL_ID} .ocp-button {
				padding: 6px 7px;
			}
			#${PANEL_ID} .ocp-input {
				padding: 7px;
			}
			#${PANEL_ID} .ocp-card {
				margin-top: 7px;
				padding: 7px;
			}
			#${PANEL_ID} .ocp-grid {
				grid-template-columns: 1fr;
				gap: 2px;
			}
			#${PANEL_ID} .ocp-value {
				text-align: left;
			}
			#${PANEL_ID} .ocp-disclosure summary {
				padding: 6px;
			}
			#${PANEL_ID} .ocp-disclosure th,
			#${PANEL_ID} .ocp-disclosure td {
				padding: 5px;
			}
		}
	`);

	registerMenuCommand("OC Planner: refresh", () => refreshRecommendations(false));
	registerMenuCommand("OC Planner: forget API key", () => {
		storage.remove(STORAGE_KEY);
		storage.remove(PROFILE_STORAGE_KEY);
		state.profile = null;
		state.lastPlanner = null;
		state.lastPayload = null;
		state.error = "";
		state.progress = "";
		state.disclosureOpen = false;
		render();
	});

	const escapeHtml = (value) =>
		String(value ?? "")
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#039;");

	const getBackendBaseUrl = () => BACKEND_BASE_URL.replace(/\/+$/, "");

	const getBackendHttpBaseUrl = () => getBackendBaseUrl().replace(/\/ws$/i, "");

	const getBackendApiUrl = (path) => {
		const base = getBackendHttpBaseUrl();
		if (!base || /YOUR_BACKEND_HOST/i.test(base)) {
			throw new Error("Backend URL is not configured in the userscript.");
		}
		return `${base}${path.startsWith("/") ? path : `/${path}`}`;
	};

	const normalizeHttpResponse = (response) => {
		if (typeof response === "string") {
			return {
				status: 200,
				responseHeaders: "content-type: application/json",
				responseText: response,
			};
		}
		if (response && typeof response === "object" && !("responseText" in response) && !("status" in response)) {
			return {
				status: 200,
				responseHeaders: "content-type: application/json",
				responseText: JSON.stringify(response),
			};
		}
		return response || {};
	};

	const sendHttpRequest = (options) => {
		const method = (options.method || "GET").toUpperCase();
		if (typeof GM_xmlhttpRequest === "function") {
			return GM_xmlhttpRequest(options);
		}
		if (isTornPda && method === "GET" && typeof window.PDA_httpGet === "function") {
			window.PDA_httpGet(options.url)
				.then((response) => options.onload?.(normalizeHttpResponse(response)))
				.catch((error) => options.onerror?.(error));
			return undefined;
		}
		if (isTornPda && method === "POST" && typeof window.PDA_httpPost === "function") {
			window.PDA_httpPost(options.url, options.headers || {}, options.data || "")
				.then((response) => options.onload?.(normalizeHttpResponse(response)))
				.catch((error) => options.onerror?.(error));
			return undefined;
		}
		window.fetch(options.url, {
			method,
			headers: options.headers || {},
			body: options.data,
			credentials: "omit",
		})
			.then(async (response) => {
				options.onload?.({
					status: response.status,
					responseHeaders: `content-type: ${response.headers.get("content-type") || ""}`,
					responseText: await response.text(),
				});
			})
			.catch((error) => options.onerror?.(error));
		return undefined;
	};

	const requestJson = (options) =>
		new Promise((resolve, reject) => {
			const timeoutId = window.setTimeout(
				() => reject(new Error(`${options.label || "Request"} timed out.`)),
				options.timeout || REQUEST_TIMEOUT_MS
			);
			sendHttpRequest({
				method: options.method || "GET",
				url: options.url,
				headers: options.headers || {},
				data: options.data,
				timeout: options.timeout || REQUEST_TIMEOUT_MS,
				onload: (response) => {
					window.clearTimeout(timeoutId);
					response = normalizeHttpResponse(response);
					const status = Number(response.status || 0);
					const contentType = String(response.responseHeaders || "")
						.split(/\r?\n/)
						.find((header) => /^content-type:/i.test(header))
						?.replace(/^content-type:\s*/i, "")
						.trim();
					if (status < 200 || status >= 300) {
						reject(new Error(`${options.label || "Request"} failed with HTTP ${status}.`));
						return;
					}
					if (contentType && !/json/i.test(contentType)) {
						const preview = String(response.responseText || "")
							.replace(/\s+/g, " ")
							.slice(0, 120);
						reject(
							new Error(
								`${options.label || "Request"} expected JSON but got ${contentType}. The backend URL is probably routed to the frontend instead of the Express API. Response starts with: ${preview}`
							)
						);
						return;
					}
					try {
						resolve(JSON.parse(response.responseText || "null"));
					} catch {
						reject(new Error(`${options.label || "Request"} returned invalid JSON.`));
					}
				},
				onerror: () => {
					window.clearTimeout(timeoutId);
					reject(new Error(`${options.label || "Request"} failed. Check the URL and network access.`));
				},
				ontimeout: () => {
					window.clearTimeout(timeoutId);
					reject(new Error(`${options.label || "Request"} timed out.`));
				},
			});
		});

	const getProfileWithKey = async (key) => {
		const url = `https://api.torn.com/user/?selections=profile&key=${encodeURIComponent(key)}&timestamp=${Date.now()}`;
		let profile = await requestJson({ url, label: "Torn profile request" });
		if (profile?.error?.code === 16 || /access level/i.test(String(profile?.error?.error || ""))) {
			profile = await requestJson({
				url: `https://api.torn.com/user/?selections=&key=${encodeURIComponent(key)}&timestamp=${Date.now()}`,
				label: "Torn profile fallback request",
			});
		}
		if (profile?.error) {
			throw new Error(profile.error.error || "Torn API rejected this key.");
		}
		if (!profile?.player_id) {
			throw new Error("Torn API did not return a player profile for this key.");
		}
		return profile;
	};

	const getLatestPlanner = async () => {
		const payload = await requestJson({
			url: getBackendApiUrl(`/api/oc-planner/bot-alerts?timestamp=${Date.now()}`),
			label: "OC Planner snapshot request",
		});
		if (!payload?.planner) {
			throw new Error("No saved OC planner run was returned by the backend.");
		}
		return payload.planner;
	};

	const getStoredKey = () => String(storage.get(STORAGE_KEY, "") || "").trim();

	const saveStoredKey = (key) => {
		const trimmed = String(key || "").trim();
		if (trimmed) storage.set(STORAGE_KEY, trimmed);
	};

	const getKeyCacheId = (key) => {
		const value = String(key || "").trim();
		if (!value) return "";
		return `${value.length}:${value.slice(0, 4)}:${value.slice(-4)}`;
	};

	const getCachedProfile = (key) => {
		const keyCacheId = getKeyCacheId(key);
		if (!keyCacheId) return null;
		try {
			const cached = JSON.parse(String(storage.get(PROFILE_STORAGE_KEY, "") || ""));
			if (cached?.keyCacheId !== keyCacheId || !cached?.profile?.player_id) return null;
			return cached.profile;
		} catch {
			return null;
		}
	};

	const saveCachedProfile = (key, profile) => {
		if (!profile?.player_id) return;
		storage.set(
			PROFILE_STORAGE_KEY,
			JSON.stringify({
				keyCacheId: getKeyCacheId(key),
				profile,
				savedAt: new Date().toISOString(),
			})
		);
	};

	const clearCachedProfile = () => {
		storage.remove(PROFILE_STORAGE_KEY);
		state.profile = null;
	};

	const isChallengePage = () => {
		const title = normalizeText(document.title);
		return (
			title.includes("just a moment") ||
			title.includes("checking your browser") ||
			!!document.querySelector(
				"#challenge-running, .cf-browser-verification, [id*='cf-challenge'], [class*='cf-challenge'], iframe[src*='challenges.cloudflare.com'], script[src*='challenges.cloudflare.com']"
			)
		);
	};

	const isOcCrimesPage = () => {
		if (isChallengePage()) return false;
		const url = new URL(window.location.href);
		const hash = decodeURIComponent(url.hash || "").toLowerCase();
		const fullUrl = decodeURIComponent(window.location.href).toLowerCase();
		return (
			url.hostname.replace(/^www\./, "") === "torn.com" &&
			url.pathname === "/factions.php" &&
			(url.searchParams.get("step") === "your" || fullUrl.includes("step=your")) &&
			(hash.includes("tab=crimes") || fullUrl.includes("tab=crimes"))
		);
	};

	const removePanel = () => {
		document.getElementById(PANEL_ID)?.remove();
		lastRenderedMarkup = "";
		state.highlightObserver?.disconnect();
		state.highlightObserver = null;
		state.highlightRetryQueued = false;
		if (state.autoRefreshTimer) {
			window.clearTimeout(state.autoRefreshTimer);
			state.autoRefreshTimer = undefined;
		}
	};

	const formatTimestamp = (secondsOrIso) => {
		if (!secondsOrIso) return "";
		const date =
			typeof secondsOrIso === "number"
				? new Date(secondsOrIso * 1000)
				: new Date(secondsOrIso);
		if (Number.isNaN(date.getTime())) return "";
		return date.toLocaleString(undefined, {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	};

	const toUnixSeconds = (secondsOrIso) => {
		if (!secondsOrIso) return 0;
		if (typeof secondsOrIso === "number") return secondsOrIso;
		const parsed = new Date(secondsOrIso).getTime();
		return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
	};

	const formatRelative = (seconds) => {
		if (!seconds) return "now";
		const diff = seconds - Math.floor(Date.now() / 1000);
		if (diff <= 0) return "now";
		const minutes = Math.round(diff / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		if (hours < 48) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
		const days = Math.floor(hours / 24);
		const remainingHours = hours % 24;
		return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`;
	};

	const formatAge = (secondsOrIso) => {
		const seconds = toUnixSeconds(secondsOrIso);
		if (!seconds) return "";
		const diff = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
		const minutes = Math.floor(diff / 60);
		if (minutes < 1) return "just now";
		if (minutes < 60) return `${minutes}m ago`;
		const hours = Math.floor(minutes / 60);
		const remainingMinutes = minutes % 60;
		if (hours < 48) return remainingMinutes ? `${hours}h ${remainingMinutes}m ago` : `${hours}h ago`;
		const days = Math.floor(hours / 24);
		return `${days}d ago`;
	};

	const formatChance = (chance) => {
		const numeric = Number(chance);
		if (!Number.isFinite(numeric)) return "";
		return `${(numeric * 100).toFixed(1)}%`;
	};

	const getFriendlyErrorMessage = (error) => {
		const message = String(error?.message || "");
		const lower = message.toLowerCase();
		if (lower.includes("torn profile") || lower.includes("torn api") || lower.includes("api rejected")) {
			return `${message} Try using a fresh Torn API key with profile access.`;
		}
		if (lower.includes("oc planner snapshot") || lower.includes("saved oc planner") || lower.includes("backend")) {
			return `${message} The planner backend may be down, blocked, or routed incorrectly.`;
		}
		if (lower.includes("expected json")) {
			return `${message} Check that /api requests reach the backend, not the frontend.`;
		}
		if (lower.includes("timed out") || lower.includes("network")) {
			return `${message} Check your connection, VPN/adblocker, and whether Torn or the planner host is reachable.`;
		}
		return message || "Could not load OC recommendation.";
	};

	const getCrimeUrl = (crimeId) => {
		const id = Number(crimeId || 0);
		if (!id) return "https://www.torn.com/factions.php?step=your&type=1#/tab=crimes";
		return `https://www.torn.com/factions.php?step=your&type=1#/tab=crimes&crimeId=${id}`;
	};

	const normalizeText = (value) =>
		String(value || "")
			.toLowerCase()
			.replace(/\s+/g, " ")
			.trim();

	const normalizeRoleText = (value) =>
		normalizeText(value)
			.replace(/[^a-z0-9]+/g, " ")
			.trim();

	const getElementCrimeId = (element) => {
		const directId =
			element.getAttribute("data-crime-id") ||
			element.getAttribute("data-crimeid") ||
			element.getAttribute("data-oc-id") ||
			"";
		if (directId) return directId;

		const href = element.getAttribute("href");
		if (href) {
			try {
				const parsed = new URL(href, window.location.origin);
				const hashParams = new URLSearchParams(parsed.hash.replace(/^#\/?/, ""));
				const hrefId =
					parsed.searchParams.get("crimeId") ||
					parsed.searchParams.get("crimeID") ||
					hashParams.get("crimeId") ||
					hashParams.get("crimeID") ||
					"";
				if (hrefId) return hrefId;
			} catch {
				const match = href.match(/[?&#]crimeI?d=(\d+)/i);
				if (match?.[1]) return match[1];
			}
		}

		const dataId = element.getAttribute("data-id") || "";
		const elementContext = normalizeText(`${element.id || ""} ${element.className || ""} ${element.textContent || ""}`);
		return dataId && /\b(oc|crime|organized)\b/.test(elementContext) ? dataId : "";
	};

	const getCrimeContainer = (element) =>
		element?.closest(
			"li, tr, [data-crime-id], [data-crimeid], [class*='crime'], [class*='Crime'], [class*='card'], [class*='row']"
		) || element;

	const findCrimeElement = (crimeId) => {
		const id = String(crimeId || "");
		if (!id) return null;

		const candidates = Array.from(
			document.querySelectorAll("a[href], button, [data-crime-id], [data-crimeid], [data-oc-id], [data-id]")
		);
		const match = candidates.find((element) => getElementCrimeId(element) === id);
		if (match) return getCrimeContainer(match);

		return candidates
			.map(getCrimeContainer)
			.find((element) => normalizeText(element?.textContent).includes(`oc #${id}`)) || null;
	};

	const findTornSlotRoleElement = (scope, roleTerms) => {
		const slotHeaders = Array.from(scope.querySelectorAll("button[class*='slotHeader'], [class*='slotHeader']"));
		const match = slotHeaders.find((header) => {
			if (header.closest(`#${PANEL_ID}`)) return false;
			const title = header.querySelector("[class*='title']");
			const text = normalizeRoleText(title?.textContent || header.textContent);
			return text && roleTerms.some((term) => text === term || text.includes(term));
		});
		return match?.closest("[class*='wrapper']") || match || null;
	};

	const findRoleElement = (crimeElement, recommendation) => {
		if (!recommendation) return null;
		const roleTerms = [
			recommendation.position,
			recommendation.role,
			recommendation.roleImpactLabel,
		]
			.map(normalizeRoleText)
			.filter(Boolean);
		if (!roleTerms.length) return null;

		const scope = crimeElement || document;
		const tornSlotMatch = findTornSlotRoleElement(scope, roleTerms);
		if (tornSlotMatch) return tornSlotMatch;

		const candidates = Array.from(
			scope.querySelectorAll(
				"li, tr, [role='row'], [class*='wrapper'], [class*='slot'], [class*='Slot'], [class*='role'], [class*='Role'], [class*='member'], [class*='Member'], button, a"
			)
		);

		const match = candidates
			.filter((element) => element !== crimeElement && !element.closest(`#${PANEL_ID}`))
			.sort((a, b) => normalizeRoleText(a.textContent).length - normalizeRoleText(b.textContent).length)
			.find((element) => {
				const text = normalizeRoleText(element.textContent);
				return text && roleTerms.some((term) => text.includes(term));
			});

		return match?.closest("li, tr, [role='row'], [class*='wrapper'], [class*='slot'], [class*='Slot'], [class*='role'], [class*='Role']") || match || null;
	};

	const clearRecommendationHighlights = () => {
		document
			.querySelectorAll(".askeladds-oc-planner-highlight")
			.forEach((element) => element.classList.remove("askeladds-oc-planner-highlight"));
		document
			.querySelectorAll(".askeladds-oc-planner-role-highlight")
			.forEach((element) => element.classList.remove("askeladds-oc-planner-role-highlight"));
	};

	const highlightRecommendation = (recommendationOrCrimeId) => {
		const recommendation =
			typeof recommendationOrCrimeId === "object" && recommendationOrCrimeId
				? recommendationOrCrimeId
				: { crimeId: recommendationOrCrimeId };
		const id = String(recommendation.crimeId || "");
		if (!id) return;
		clearRecommendationHighlights();

		const crimeElement = findCrimeElement(id);
		crimeElement?.classList.add("askeladds-oc-planner-highlight");

		const roleElement = findRoleElement(crimeElement, recommendation);
		roleElement?.classList.add("askeladds-oc-planner-role-highlight");
		(roleElement || crimeElement)?.scrollIntoView?.({ behavior: "smooth", block: "center" });
		return !!roleElement;
	};

	const queueHighlightRecommendation = (recommendation) => {
		if (!recommendation?.crimeId) return;
		state.lastHighlightRecommendation = recommendation;
		state.pendingHighlight = {
			recommendation,
			startedAt: Date.now(),
		};
		state.highlightObserver?.disconnect();
		if (typeof MutationObserver === "function" && document.body) {
			state.highlightObserver = new MutationObserver(() => {
				if (!state.pendingHighlight || state.highlightRetryQueued) return;
				state.highlightRetryQueued = true;
				window.setTimeout(() => {
					state.highlightRetryQueued = false;
					retryPendingHighlight();
				}, 150);
			});
			state.highlightObserver.observe(document.body, { childList: true, subtree: true });
		}
		[150, 400, 800, 1300, 2000, 3000, 4500, 6500, 9000, 12000, 16000].forEach((delay) => {
			window.setTimeout(() => retryPendingHighlight(), delay);
		});
	};

	const retryPendingHighlight = () => {
		const pending = state.pendingHighlight;
		if (!pending) return;
		highlightRecommendation(pending.recommendation);
		if (Date.now() - pending.startedAt > 17000) {
			state.pendingHighlight = null;
			state.highlightObserver?.disconnect();
			state.highlightObserver = null;
			state.highlightRetryQueued = false;
		}
	};

	const getMemberId = (member) =>
		Number(
			member?.memberId ||
				member?.playerId ||
				member?.player_id ||
				member?.id ||
				0
		);

	const getMemberName = (member) => {
		if (!member) return "";
		if (typeof member === "string") return member;
		const id = getMemberId(member);
		return (
			member.memberName ||
			member.playerName ||
			member.player_name ||
			member.name ||
			member.username ||
			(id ? `Player ${id}` : "")
		);
	};

	const getSlotMember = (slot) => {
		const member =
			slot.expectedMember ||
			slot.plannedMember ||
			slot.assignedMember ||
			slot.currentMember ||
			slot.member ||
			slot.user ||
			slot.participant ||
			slot.recommended ||
			slot.soonRecommended;
		const name =
			getMemberName(member) ||
			slot.expectedMemberName ||
			slot.plannedMemberName ||
			slot.assignedMemberName ||
			slot.currentMemberName ||
			slot.memberName ||
			slot.playerName ||
			slot.name;
		const id =
			getMemberId(member) ||
			Number(
				slot.expectedMemberId ||
					slot.plannedMemberId ||
					slot.assignedMemberId ||
					slot.currentMemberId ||
					slot.memberId ||
					slot.playerId ||
					0
			);
		return {
			id,
			name: name || (id ? `Player ${id}` : "Open"),
		};
	};

	const getExpectedTeam = (crime, memberId) =>
		(crime?.slots || []).map((slot, index) => {
			const member = getSlotMember(slot);
			return {
				slot: slot.position || slot.role || slot.roleImpactLabel || `Slot ${index + 1}`,
				memberId: member.id,
				memberName: member.name,
				isYou: Number(member.id) === Number(memberId),
			};
		});

	const findSlotRecommendations = (planner, memberId) => {
		const recommendations = [];
		for (const crime of planner?.crimes || []) {
			for (const slot of crime.slots || []) {
				const recommended =
					Number(slot.recommended?.memberId) === memberId
						? slot.recommended
						: Number(slot.soonRecommended?.memberId) === memberId
							? slot.soonRecommended
							: undefined;

				if (!recommended) continue;

				recommendations.push({
					type: "slot",
					crimeId: crime.id,
					crimeName: crime.name || slot.crimeName || recommended.cprCrimeName,
					difficulty: crime.difficulty,
					status: crime.status || slot.status,
					position: slot.position,
					role: slot.role || recommended.cprRoleName,
					roleImpactLabel: slot.roleImpactLabel,
					cpr: recommended.cpr,
					available: recommended.available,
					availableAt: recommended.availableAt,
					currentCrimeId: recommended.currentCrimeId,
					currentCrimeName: recommended.currentCrimeName,
					planningState: slot.planningState,
					planningStep: slot.planningStep,
					globalPlanningStep: slot.globalPlanningStep,
					estimatedStartWaitHours: slot.estimatedStartWaitHours,
					plannedStartAt: slot.plannedStartAt,
					plannedMemberEndAt: slot.plannedMemberEndAt,
					plannedOcCompleteAt: slot.plannedOcCompleteAt,
					successChance: crime.recommendedSuccessChance,
					successBand: crime.successBand,
					expectedTeam: getExpectedTeam(crime, memberId),
					warnings: crime.warnings || [],
				});
			}
		}
		return recommendations.sort(
			(a, b) =>
				(a.globalPlanningStep || 9999) - (b.globalPlanningStep || 9999) ||
				(a.planningStep || 9999) - (b.planningStep || 9999) ||
				(a.plannedStartAt || 0) - (b.plannedStartAt || 0)
		);
	};

	const findPlanningSteps = (planner, memberId) =>
		(planner?.planningSteps || [])
			.filter((step) => Number(step.memberId) === memberId)
			.sort(
				(a, b) =>
					(a.globalStep || 9999) - (b.globalStep || 9999) ||
					(a.step || 9999) - (b.step || 9999)
			);

	const findUnassigned = (planner, memberId) =>
		(planner?.unassignedMembers || []).filter(
			(member) => Number(member.memberId) === memberId
		);

	const buildMemberPayload = (profile, planner) => {
		const memberId = Number(profile?.player_id || profile?.profile?.player_id || 0);
		const memberName =
			profile?.name ||
			profile?.player_name ||
			profile?.profile?.name ||
			profile?.profile?.player_name ||
			(memberId ? `Player ${memberId}` : "");
		const recommendations = findSlotRecommendations(planner, memberId);
		const planningSteps = findPlanningSteps(planner, memberId);
		const unassigned = findUnassigned(planner, memberId);
		const missingCpr = (planner?.missingCprMembers || []).some(
			(member) => Number(member.memberId) === memberId
		);

		return {
			memberId,
			memberName,
			plannerGeneratedAt: planner?.generatedAt,
			summary: planner?.summary,
			recommendations,
			planningSteps,
			unassigned,
			missingCpr,
			warnings: planner?.warnings || [],
		};
	};

	const syncInteractiveState = () => {
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		state.collapsed = panel.classList.contains("collapsed");
		state.disclosureOpen = !!panel.querySelector(".ocp-disclosure")?.open;
	};

	const setCollapsed = (collapsed) => {
		state.collapsed = !!collapsed;
		storage.set(COLLAPSED_STORAGE_KEY, state.collapsed ? "1" : "0");
		document.getElementById(PANEL_ID)?.classList.toggle("collapsed", state.collapsed);
		render();
	};

	const addTapHandler = (element, handler) => {
		if (!element) return;
		let lastTouchAt = 0;
		element.addEventListener("touchend", (event) => {
			lastTouchAt = Date.now();
			event.preventDefault();
			handler(event);
		});
		element.addEventListener("click", (event) => {
			if (Date.now() - lastTouchAt < 500) return;
			handler(event);
		});
	};

	const collapsePanelWithoutRender = () => {
		state.collapsed = true;
		document.getElementById(PANEL_ID)?.classList.add("collapsed");
	};

	const refreshRecommendations = async (force) => {
		if (state.loading) return;

		const keyInput = document.querySelector(`#${PANEL_ID} .ocp-api-key`);
		const key = String(keyInput?.value || getStoredKey()).trim();
		if (!key) {
			state.error = "Enter your Torn API key first.";
			render();
			return;
		}

		saveStoredKey(key);
		state.loading = true;
		state.error = "";
		state.progress = "Loading your Torn profile...";
		render();

		try {
			state.profile = getCachedProfile(key);
			if (!state.profile) {
				state.progress = "Validating API key with Torn...";
				render();
				state.profile = await getProfileWithKey(key);
				saveCachedProfile(key, state.profile);
			}

			state.progress = "Loading latest OC planner snapshot...";
			render();

			const planner = await getLatestPlanner();

			state.lastPlanner = planner;
			state.lastPayload = buildMemberPayload(state.profile, planner);
			state.progress = "";
			state.error = "";
			scheduleAutoRefresh();
			clearRecommendationHighlights();
		} catch (error) {
			state.error = getFriendlyErrorMessage(error);
			state.progress = "";
		} finally {
			state.loading = false;
			render();
		}
	};

	const scheduleAutoRefresh = () => {
		if (state.autoRefreshTimer) window.clearTimeout(state.autoRefreshTimer);
		state.autoRefreshTimer = window.setTimeout(() => {
			if (document.visibilityState === "hidden") {
				scheduleAutoRefresh();
				return;
			}
			if (state.active && isOcCrimesPage() && getStoredKey()) {
				refreshRecommendations(false);
			}
		}, AUTO_REFRESH_MS);
	};

	const resumeVisibleRefresh = () => {
		if (document.visibilityState !== "visible") return;
		if (state.active && isOcCrimesPage() && getStoredKey() && !state.loading) {
			refreshRecommendations(false);
		}
	};

	const statItem = (label, value) =>
		value
			? `<span class="ocp-stat"><span class="ocp-stat-label">${escapeHtml(label)}</span><span class="ocp-stat-value">${escapeHtml(value)}</span></span>`
			: "";

	const statRow = (...items) => {
		const markup = items.filter(Boolean).join("");
		return markup ? `<div class="ocp-stat-row">${markup}</div>` : "";
	};

	const recommendationCard = (recommendation, index) => {
		const isNext = recommendation.planningState === "next" || index === 0;
		const crimeUrl = getCrimeUrl(recommendation.crimeId);
		const startLabel =
			recommendation.plannedStartAt && recommendation.plannedStartAt > Math.floor(Date.now() / 1000)
				? `${formatRelative(recommendation.plannedStartAt)} (${formatTimestamp(recommendation.plannedStartAt)})`
				: "now";
		const plannedFinishAt = recommendation.plannedOcCompleteAt || recommendation.plannedMemberEndAt;
		const finishLabel = plannedFinishAt
			? `${formatRelative(plannedFinishAt)} (${formatTimestamp(plannedFinishAt)})`
			: "";
		const successChance = formatChance(recommendation.successChance);
		const step = recommendation.planningStep;
		const expectedTeam = (recommendation.expectedTeam || [])
			.map(
				(member) => `
					<span class="ocp-team-chip ${member.isYou ? "you" : ""}">
						<span class="ocp-chip-slot">${escapeHtml(member.slot)}:</span>
						<span class="ocp-chip-member">${escapeHtml(member.memberName)}</span>
					</span>
				`
			)
			.join("");

		return `
			<div class="ocp-card ${isNext ? "next" : ""}">
				<div class="ocp-card-heading">
					<span class="ocp-card-title">${escapeHtml(isNext ? "Join Next" : "Queued")}</span>
					<span>${escapeHtml(recommendation.crimeName || "Organized crime")}</span>
					<span class="ocp-muted">${escapeHtml(recommendation.position || recommendation.role || "Slot")}</span>
				</div>
				${statRow(statItem("Start", startLabel), statItem("Finish", finishLabel))}
				${statRow(
					statItem("CPR", `${Math.round(Number(recommendation.cpr || 0))}%`),
					statItem("Success", successChance),
					statItem("Tier", recommendation.difficulty ? `T${recommendation.difficulty}` : "")
				)}
				${statRow(
					statItem("Done", recommendation.currentCrimeName),
					statItem("Step", step ? `#${step}` : "")
				)}
				${expectedTeam ? `<div class="ocp-team"><div class="ocp-team-title">Expected team</div><div class="ocp-team-chips">${expectedTeam}</div></div>` : ""}
				<a class="ocp-card-link" href="${escapeHtml(crimeUrl)}" data-ocp-crime-id="${escapeHtml(recommendation.crimeId)}" data-ocp-role="${escapeHtml(recommendation.role || "")}" data-ocp-position="${escapeHtml(recommendation.position || "")}" data-ocp-role-impact="${escapeHtml(recommendation.roleImpactLabel || "")}">Go to OC #${escapeHtml(recommendation.crimeId)}</a>
			</div>
		`;
	};

	const unassignedCard = (member) => `
		<div class="ocp-card need-more">
			<div class="ocp-card-title">No Slot Assigned</div>
			<div>Planner knows your CPR, but there is no good open slot for you right now.</div>
			<div class="ocp-grid">
				${member.bestCprCrimeName ? `<div class="ocp-label">Best fit</div><div class="ocp-value">${escapeHtml(member.bestCprCrimeName)}</div>` : ""}
				${member.bestCprRoleName ? `<div class="ocp-label">Role</div><div class="ocp-value">${escapeHtml(member.bestCprRoleName)}</div>` : ""}
				${member.bestCpr ? `<div class="ocp-label">CPR</div><div class="ocp-value">${escapeHtml(Math.round(Number(member.bestCpr)))}%</div>` : ""}
				${member.availableAt ? `<div class="ocp-label">Available</div><div class="ocp-value">${escapeHtml(formatRelative(member.availableAt))}</div>` : ""}
			</div>
		</div>
	`;

	const renderResults = () => {
		const payload = state.lastPayload;
		if (!payload) return "";

		const cards = payload.recommendations.map(recommendationCard).join("");
		const plannerAge = formatAge(payload.plannerGeneratedAt);
		const plannerGeneratedSeconds = toUnixSeconds(payload.plannerGeneratedAt);
		const isStale =
			plannerGeneratedSeconds > 0 &&
			Math.floor(Date.now() / 1000) - plannerGeneratedSeconds > STALE_PLANNER_SECONDS;
		const plannerPill = plannerAge
			? `<span class="ocp-pill ${isStale ? "stale" : ""}">${escapeHtml(isStale ? `Stale ${plannerAge}` : `Planner ${plannerAge}`)}</span>`
			: "";
		const unassigned = !payload.recommendations.length
			? payload.unassigned.map(unassignedCard).join("")
			: "";
		const missingCpr = payload.missingCpr
			? `<div class="ocp-card need-more"><div class="ocp-card-title">Missing CPR</div><div>Your CPR is missing from TornStats/Supabase, so the planner cannot place you yet.</div></div>`
			: "";
		const empty = !cards && !unassigned && !missingCpr
			? `<div class="ocp-card"><div class="ocp-card-title">Nothing To Join</div><div>No personal OC recommendation was found in the latest planner run.</div></div>`
			: "";

		return `
			<div class="ocp-status-line">
				<span>${escapeHtml(payload.memberName || "You")}</span>
				${plannerPill}
				${payload.plannerGeneratedAt ? `<span class="ocp-muted">${escapeHtml(formatTimestamp(payload.plannerGeneratedAt))}</span>` : ""}
			</div>
			${cards}
			${unassigned}
			${missingCpr}
			${empty}
		`;
	};

	const render = () => {
		if (!state.active || !isOcCrimesPage()) {
			removePanel();
			return;
		}

		syncInteractiveState();
		let panel = document.getElementById(PANEL_ID);
		if (!panel) {
			panel = document.createElement("div");
			panel.id = PANEL_ID;
			document.body.appendChild(panel);
			if (state.collapsed) panel.classList.add("collapsed");
		}

		const savedKey = getStoredKey();
		const backendConfigured = !/YOUR_BACKEND_HOST/i.test(getBackendBaseUrl());
		const collapsed = state.collapsed;
		const highlightAgain = state.lastHighlightRecommendation
			? `<button class="ocp-button ocp-highlight-again" title="Highlight recommendation again">HL</button>`
			: "";
		const keyControls = savedKey
			? `
				<div class="ocp-row">
					<button class="ocp-button primary ocp-save-refresh">${state.loading ? "Loading" : "Refresh"}</button>
					<button class="ocp-button danger ocp-forget">Change key</button>
				</div>
			`
			: `
				<div class="ocp-muted">Torn API key</div>
				<div class="ocp-row">
					<input class="ocp-input ocp-api-key" type="password" value="" placeholder="Paste Torn API key">
					<button class="ocp-button primary ocp-save-refresh">${state.loading ? "Loading" : "Refresh"}</button>
				</div>
			`;

		const markup = `
			<div class="ocp-header">
				<div class="ocp-title">OC Planner</div>
				<div class="ocp-actions">
					${highlightAgain}
					<button class="ocp-icon-button ocp-collapse" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? "+" : "-"}</button>
				</div>
			</div>
			<div class="ocp-body">
				${backendConfigured ? "" : `<div class="ocp-error">Set BACKEND_BASE_URL in the userscript before using it.</div>`}
				${keyControls}
				${state.progress ? `<div class="ocp-status">${escapeHtml(state.progress)}</div>` : ""}
				${state.error ? `<div class="ocp-error">${escapeHtml(state.error)}</div>` : ""}
				${renderResults()}
				<details class="ocp-disclosure"${state.disclosureOpen ? " open" : ""}>
					<summary>${savedKey ? "Privacy" : "API key use"}</summary>
					<table>
						<tr><th>Data storage</th><td>API key and profile cache are stored locally by your userscript manager or Torn PDA.</td></tr>
						<tr><th>Data sharing</th><td>Your key is sent to Torn's official API for profile lookup. It is not sent to the OC Planner backend.</td></tr>
						<tr><th>Purpose of use</th><td>Show your own OC Planner recommendation on the faction crimes page.</td></tr>
						<tr><th>Key storage and sharing</th><td>Stored locally only. The userscript never asks the backend to save your key.</td></tr>
						<tr><th>Required access</th><td>Enough access for Torn profile lookup. OC data is fetched from the backend's latest saved planner snapshot.</td></tr>
					</table>
				</details>
				<div class="ocp-footer">Displays advice only. It does not click, join, submit, or automate Torn actions.</div>
			</div>
		`;

		if (markup === lastRenderedMarkup) return;
		panel.innerHTML = markup;
		lastRenderedMarkup = markup;
		panel.classList.toggle("collapsed", state.collapsed);

		const toggleCollapsed = () => {
			setCollapsed(!state.collapsed);
		};
		addTapHandler(panel.querySelector(".ocp-header"), toggleCollapsed);
		addTapHandler(panel.querySelector(".ocp-collapse"), (event) => {
			event.stopPropagation();
			toggleCollapsed();
		});
		addTapHandler(panel.querySelector(".ocp-highlight-again"), (event) => {
			event.stopPropagation();
			queueHighlightRecommendation(state.lastHighlightRecommendation);
		});
		panel.querySelector(".ocp-disclosure")?.addEventListener("toggle", (event) => {
			state.disclosureOpen = !!event.currentTarget.open;
		});
		panel.querySelectorAll(".ocp-card-link").forEach((link) => {
			const recommendation = {
				crimeId: link.dataset.ocpCrimeId,
				role: link.dataset.ocpRole,
				position: link.dataset.ocpPosition,
				roleImpactLabel: link.dataset.ocpRoleImpact,
			};
			const prepareOcNavigation = () => {
				queueHighlightRecommendation(recommendation);
			};
			const collapseAfterNavigationTap = () => {
				window.setTimeout(() => collapsePanelWithoutRender(), 50);
			};
			link.addEventListener("pointerdown", prepareOcNavigation);
			link.addEventListener("touchstart", prepareOcNavigation);
			link.addEventListener("touchend", collapseAfterNavigationTap);
			link.addEventListener("click", () => {
				prepareOcNavigation();
				collapseAfterNavigationTap();
			});
		});
		panel.querySelector(".ocp-save-refresh")?.addEventListener("click", () => refreshRecommendations(false));
		panel.querySelector(".ocp-forget")?.addEventListener("click", () => {
			storage.remove(STORAGE_KEY);
			storage.remove(PROFILE_STORAGE_KEY);
			state.profile = null;
			state.lastPlanner = null;
			state.lastPayload = null;
			state.error = "Paste a new Torn API key.";
			state.progress = "";
			state.disclosureOpen = false;
			render();
		});
		panel.querySelector(".ocp-api-key")?.addEventListener("keydown", (event) => {
			if (event.key === "Enter") refreshRecommendations(false);
		});
	};

	const start = () => {
		state.active = isOcCrimesPage();
		render();
		if (state.active && getStoredKey() && !/YOUR_BACKEND_HOST/i.test(getBackendBaseUrl())) {
			refreshRecommendations(false);
		}
	};

	const syncPageActivation = () => {
		const shouldBeActive = isOcCrimesPage();
		if (state.active === shouldBeActive) {
			return;
		}

		state.active = shouldBeActive;
		if (!shouldBeActive) {
			removePanel();
			return;
		}

		render();
		if (getStoredKey() && !/YOUR_BACKEND_HOST/i.test(getBackendBaseUrl())) {
			refreshRecommendations(false);
		}
	};

	window.addEventListener("hashchange", () => {
		syncPageActivation();
		window.setTimeout(() => retryPendingHighlight(), 600);
		window.setTimeout(() => retryPendingHighlight(), 1600);
	});
	window.addEventListener("popstate", () => {
		syncPageActivation();
		window.setTimeout(() => retryPendingHighlight(), 600);
		window.setTimeout(() => retryPendingHighlight(), 1600);
	});
	document.addEventListener("visibilitychange", resumeVisibleRefresh);
	window.setInterval(syncPageActivation, 1500);

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", start, { once: true });
	} else {
		start();
	}
})();
