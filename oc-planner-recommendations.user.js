// ==UserScript==
// @name         AskeLadds OC Planner Recommendations
// @namespace    https://askeladds.local/oc-planner
// @version      0.2.61
// @description  Shows OC recommendations on Torn.
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
// @connect      backend.grusmedia.no
// @connect      askelads.grusmedia.no
// @noframes
// ==/UserScript==

(() => {
	"use strict";

	const BACKEND_BASE_URL = "https://backend.grusmedia.no";
	const SCRIPT_VERSION = "0.2.61";

	const STORAGE_KEY = "askeladds_oc_planner_api_key";
	const PROFILE_STORAGE_KEY = "askeladds_oc_planner_profile";
	const PAYLOAD_STORAGE_KEY = "askeladds_oc_planner_member_payload";
	const SCRIPT_ACCESS_STORAGE_KEY = "askeladds_oc_planner_script_access";
	const COLLAPSED_STORAGE_KEY = "askeladds_oc_planner_collapsed";
	const POSITION_STORAGE_KEY = "askeladds_oc_planner_position";
	const PANEL_ID = "askeladds-oc-planner-panel";
	const JOIN_CUE_BADGE_CLASS = "askeladds-oc-planner-join-cue";
	const CPR_ELIGIBLE_ROLE_CLASS = "askeladds-oc-planner-role-cpr-eligible";
	const REQUEST_TIMEOUT_MS = 60000;
	const AUTO_REFRESH_MS = 5 * 60 * 1000;
	const ACTIVE_REFRESH_MS = 60 * 1000;
	const PROFILE_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
	const SCRIPT_ACCESS_INTERVAL_MS = 6 * 60 * 60 * 1000;
	const PANEL_EDGE_GAP = 8;
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
	const savedCollapsedPreference = String(storage.get(COLLAPSED_STORAGE_KEY, "") || "");
	const initialCollapsed = savedCollapsedPreference
		? savedCollapsedPreference === "1"
		: !!String(storage.get(STORAGE_KEY, "") || "").trim();

	const state = {
		profile: null,
		lastPlanner: null,
		lastPayload: null,
		lastCheckedAt: 0,
		lastAttemptAt: 0,
		snapshotRevision: "",
		usingCachedPayload: false,
		loading: false,
		error: "",
		progress: "",
		autoRefreshTimer: undefined,
		active: false,
		collapsed: initialCollapsed,
		disclosureOpen: false,
		flexibleOpen: false,
		pendingHighlight: null,
		lastHighlightRecommendation: null,
		targetFeedback: null,
		takenRecommendationKeys: new Set(),
		highlightObserver: null,
		highlightRetryQueued: false,
		pageObserver: null,
		domSyncTimer: undefined,
		dragSuppressTapUntil: 0,
	};

	let lastRenderedMarkup = "";

	addStyle(`
		#${PANEL_ID} {
			box-sizing: border-box;
			position: fixed;
			right: 14px;
			bottom: 54px;
			z-index: 999999;
			width: min(318px, calc(100vw - 28px));
			max-height: calc(100vh - 28px);
			font: 12px/1.35 Arial, Helvetica, sans-serif;
			color: #f1e8d7;
			background:
				linear-gradient(145deg, rgba(31, 23, 14, 0.97), rgba(9, 8, 7, 0.98) 58%),
				#0d0b09;
			border: 1px solid #5c4318;
			border-radius: 8px;
			box-shadow: 0 16px 38px rgba(0, 0, 0, 0.58), 0 0 0 1px rgba(216, 164, 57, 0.08) inset;
			overflow: hidden;
		}
		#${PANEL_ID}.collapsed .ocp-body {
			display: none;
		}
		#${PANEL_ID}.collapsed {
			width: min(230px, calc(100vw - 28px));
			box-shadow: 0 8px 22px rgba(0, 0, 0, 0.42);
		}
		#${PANEL_ID}.collapsed .ocp-header {
			border-bottom: 0;
		}
		#${PANEL_ID} * {
			box-sizing: border-box;
		}
		#${PANEL_ID} [hidden] {
			display: none !important;
		}
		#${PANEL_ID} button,
		#${PANEL_ID} input {
			font: inherit;
		}
		#${PANEL_ID} .ocp-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 4px;
			padding: 4px 6px;
			background: linear-gradient(180deg, rgba(35, 25, 14, 0.96), rgba(14, 11, 8, 0.96));
			border-bottom: 1px solid #5c4318;
			cursor: pointer;
			user-select: none;
			touch-action: none;
		}
		#${PANEL_ID} .ocp-header:hover {
			cursor: move;
		}
		#${PANEL_ID}.ocp-dragging {
			transition: none;
		}
		#${PANEL_ID} .ocp-title {
			min-width: 0;
			flex: 0 1 auto;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-weight: 700;
			font-size: 13px;
			letter-spacing: 0;
			color: #f4d990;
			text-shadow: 0 1px 0 #000;
		}
		#${PANEL_ID} .ocp-title-line {
			display: flex;
			align-items: center;
			gap: 4px;
			min-width: 0;
		}
		#${PANEL_ID} .ocp-version {
			flex: 0 0 auto;
			font-size: 9px;
			font-weight: 600;
			color: #8f8678;
		}
		#${PANEL_ID} .ocp-state-dot {
			width: 6px;
			height: 6px;
			flex: 0 0 6px;
			border-radius: 50%;
			background: #77736b;
			box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
		}
		#${PANEL_ID} .ocp-state-dot.ready {
			background: #74bf68;
			box-shadow: 0 0 6px rgba(116, 191, 104, 0.58);
		}
		#${PANEL_ID} .ocp-state-dot.loading {
			background: #d3a33e;
		}
		#${PANEL_ID} .ocp-state-dot.error {
			background: #d96b5c;
		}
		#${PANEL_ID} .ocp-title-group {
			min-width: 0;
			flex: 1;
		}
		#${PANEL_ID} .ocp-target-feedback {
			display: block;
			margin-top: 1px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			font-size: 10px;
			font-weight: 700;
			color: #e9cc87;
		}
		#${PANEL_ID} .ocp-target-feedback.found,
		#${PANEL_ID} .ocp-target-feedback.joined {
			color: #aee3a5;
		}
		#${PANEL_ID} .ocp-target-feedback.filled,
		#${PANEL_ID} .ocp-target-feedback.missing {
			color: #ffb7a9;
		}
		#${PANEL_ID} .ocp-actions {
			display: flex;
			align-items: center;
			gap: 6px;
		}
		#${PANEL_ID} .ocp-highlight-again {
			padding: 3px 5px;
			font-weight: 700;
			line-height: 1;
		}
		#${PANEL_ID} .ocp-highlight-stop {
			padding: 3px 5px;
			font-weight: 700;
			line-height: 1;
		}
		#${PANEL_ID} .ocp-icon-button,
		#${PANEL_ID} .ocp-button {
			border: 1px solid #4d5860;
			background: linear-gradient(180deg, #2c3338, #171b1f);
			color: #f3f0e8;
			border-radius: 6px;
			cursor: pointer;
			font-weight: 700;
			box-shadow: 0 1px 0 rgba(255, 255, 255, 0.07) inset;
		}
		#${PANEL_ID} .ocp-icon-button {
			width: 22px;
			height: 22px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			padding: 0;
		}
		#${PANEL_ID} .ocp-button {
			padding: 4px 6px;
		}
		#${PANEL_ID} .ocp-icon-button:hover,
		#${PANEL_ID} .ocp-button:hover {
			filter: brightness(1.1);
		}
		#${PANEL_ID} .ocp-button.primary {
			border-color: #9f741d;
			background: linear-gradient(180deg, #8b661f, #49300b);
			color: #fff4d7;
		}
		#${PANEL_ID} .ocp-button.danger {
			border-color: #7a3035;
			background: linear-gradient(180deg, #6a2c30, #351015);
			color: #ffe5e5;
		}
		#${PANEL_ID} .ocp-body {
			padding: 6px;
			max-height: calc(100vh - 64px);
			overflow-y: auto;
			overscroll-behavior: contain;
		}
		#${PANEL_ID} .ocp-row {
			display: flex;
			gap: 5px;
			margin-top: 5px;
		}
		#${PANEL_ID} .ocp-toolbar {
			display: grid;
			grid-template-columns: auto minmax(0, 1fr);
			align-items: center;
			gap: 4px;
			margin-top: 0;
		}
		#${PANEL_ID} .ocp-toolbar-status {
			min-width: 0;
			border: 1px solid #4a3718;
			background: rgba(12, 11, 9, 0.78);
			color: #d9caa9;
			border-radius: 6px;
			padding: 3px 5px;
			font-size: 11px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
			text-align: right;
			box-shadow: 0 1px 0 rgba(255, 255, 255, 0.04) inset;
		}
		#${PANEL_ID} .ocp-row input {
			min-width: 0;
			flex: 1;
		}
		#${PANEL_ID} .ocp-input {
			width: 100%;
			border: 1px solid #4a3718;
			background: rgba(5, 5, 4, 0.78);
			color: #f1e8d7;
			border-radius: 8px;
			padding: 6px;
		}
		#${PANEL_ID} .ocp-muted {
			color: #b7ad9e;
		}
		#${PANEL_ID} .ocp-error {
			margin-top: 6px;
			color: #ffdada;
			background: rgba(64, 18, 22, 0.76);
			border: 1px solid #7a3035;
			border-radius: 8px;
			padding: 6px;
		}
		#${PANEL_ID} .ocp-status {
			margin-top: 6px;
			color: #bee9b8;
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
			border: 1px solid #6d531f;
			background: rgba(61, 42, 12, 0.72);
			color: #f2d890;
			border-radius: 7px;
			padding: 2px 5px;
			font-size: 11px;
		}
		#${PANEL_ID} .ocp-card {
			margin-top: 5px;
			padding: 6px;
			border: 1px solid #443319;
			background: rgba(18, 15, 11, 0.78);
			border-radius: 8px;
		}
		#${PANEL_ID} .ocp-card.next {
			border-color: #618f50;
			background: linear-gradient(180deg, rgba(23, 48, 24, 0.86), rgba(14, 27, 15, 0.86));
		}
		#${PANEL_ID} .ocp-card.plan {
			padding: 0;
			border: 0;
			background: transparent;
		}
		#${PANEL_ID} .ocp-card.plan.next {
			background: transparent;
		}
		#${PANEL_ID} .ocp-plan-box {
			margin-top: 4px;
			padding: 5px 6px;
			border: 1px solid #443319;
			background: rgba(18, 15, 11, 0.78);
			border-radius: 7px;
		}
		#${PANEL_ID} .ocp-plan-box.current {
			background: rgba(12, 12, 11, 0.76);
		}
		#${PANEL_ID} .ocp-plan-box.next {
			border-color: #618f50;
			background: linear-gradient(180deg, rgba(23, 48, 24, 0.86), rgba(14, 27, 15, 0.86));
		}
		#${PANEL_ID} .ocp-card-link {
			display: inline-flex;
			align-items: center;
			justify-content: space-between;
			gap: 5px;
			margin-top: 4px;
			width: 100%;
			border: 1px solid #65a25d;
			background: linear-gradient(180deg, #315d35, #17361e);
			color: #f2fff1;
			padding: 5px 6px;
			text-decoration: none;
			font-weight: 700;
			border-radius: 6px;
			box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08) inset;
		}
		#${PANEL_ID} .ocp-plan-box.ocp-card-link {
			display: block;
			margin-top: 4px;
			border-radius: 7px;
		}
		#${PANEL_ID} .ocp-next-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 5px;
		}
		#${PANEL_ID} .ocp-card-link:hover {
			filter: brightness(1.1);
		}
		#${PANEL_ID} .ocp-compact-line {
			display: grid;
			grid-template-columns: 64px minmax(0, 1fr);
			align-items: baseline;
			gap: 6px;
			margin-top: 2px;
		}
		#${PANEL_ID} .ocp-line-label {
			color: #b7ad9e;
			font-weight: 700;
			font-size: 11px;
			text-transform: uppercase;
		}
		#${PANEL_ID} .ocp-line-value {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} .ocp-next-main {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} .ocp-next-meta {
			flex: 0 0 auto;
			color: #d8f4cf;
			font-size: 11px;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-mini-meta {
			display: flex;
			flex-wrap: wrap;
			gap: 3px 7px;
			margin-top: 4px;
			color: #b7ad9e;
			font-size: 11px;
		}
		#${PANEL_ID} .ocp-cpr-overview {
			margin-top: 5px;
			padding: 5px 6px;
			border: 1px solid #618f50;
			border-radius: 7px;
			background: linear-gradient(180deg, rgba(23, 48, 24, 0.86), rgba(14, 27, 15, 0.86));
		}
		#${PANEL_ID} .ocp-cpr-summary {
			display: flex;
			align-items: baseline;
			gap: 6px;
			min-width: 0;
			white-space: nowrap;
		}
		#${PANEL_ID} .ocp-cpr-mode {
			color: #f1e8d7;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-cpr-counts {
			display: flex;
			align-items: baseline;
			gap: 5px;
			min-width: 0;
			color: #b7ad9e;
			font-size: 11px;
		}
		#${PANEL_ID} .ocp-cpr-counts strong {
			color: #b8efa7;
		}
		#${PANEL_ID} .ocp-cpr-rule {
			display: flex;
			align-items: center;
			gap: 4px;
			margin-top: 2px;
			color: #c7d8c1;
			font-size: 10px;
			line-height: 1.2;
		}
		#${PANEL_ID} .ocp-cpr-swatch {
			width: 8px;
			height: 8px;
			flex: 0 0 8px;
			border: 1px solid #a7ee9f;
			border-radius: 2px;
			background: #4f9b49;
			box-shadow: 0 0 5px rgba(118, 210, 109, 0.68);
		}
		#${PANEL_ID} .ocp-cpr-warning {
			margin-top: 4px;
			padding-top: 4px;
			border-top: 1px solid rgba(97, 143, 80, 0.42);
		}
		#${PANEL_ID} .ocp-cpr-warning .ocp-flexible-note {
			margin: 0;
		}
		.${CPR_ELIGIBLE_ROLE_CLASS} {
			outline: 3px solid #76d26d !important;
			box-shadow: 0 0 0 3px rgba(118, 210, 109, 0.24), 0 0 16px rgba(118, 210, 109, 0.42) !important;
		}
		.askeladds-oc-planner-role-highlight {
			outline: 3px solid #ffd166 !important;
			box-shadow: 0 0 0 3px rgba(255, 209, 102, 0.26), 0 0 18px rgba(255, 209, 102, 0.5) !important;
		}
		.askeladds-oc-planner-role-highlight.askeladds-oc-planner-role-filled {
			outline-color: #ff806f !important;
			box-shadow: 0 0 0 3px rgba(255, 128, 111, 0.24), 0 0 18px rgba(255, 128, 111, 0.48) !important;
		}
		.${JOIN_CUE_BADGE_CLASS} {
			display: inline-flex;
			align-items: center;
			max-width: min(340px, 65vw);
			margin-left: 7px;
			padding: 2px 6px;
			border: 1px solid #b88725;
			border-radius: 5px;
			background: rgba(61, 42, 12, 0.94);
			color: #ffe1a0;
			font: 700 11px/1.2 Arial, Helvetica, sans-serif;
			vertical-align: middle;
			white-space: normal;
			cursor: help;
			pointer-events: auto;
			user-select: none;
		}
		.${JOIN_CUE_BADGE_CLASS}.opening {
			border-color: #6f8fb5;
			background: rgba(18, 39, 61, 0.94);
			color: #cde4ff;
		}
		.${JOIN_CUE_BADGE_CLASS}.found,
		.${JOIN_CUE_BADGE_CLASS}.joined {
			border-color: #5d9b54;
			background: rgba(22, 55, 24, 0.94);
			color: #c9f3c1;
		}
		.${JOIN_CUE_BADGE_CLASS}.filled,
		.${JOIN_CUE_BADGE_CLASS}.missing {
			border-color: #a54e43;
			background: rgba(65, 24, 20, 0.95);
			color: #ffc4b9;
		}
		#${PANEL_ID} .ocp-card.need-more {
			border-color: #8d6c25;
			background: rgba(49, 35, 10, 0.78);
		}
		#${PANEL_ID} .ocp-card.no-plan {
			border-color: #6d531f;
			background: linear-gradient(180deg, rgba(47, 36, 17, 0.82), rgba(22, 18, 12, 0.82));
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
			color: #b7ad9e;
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
			color: #b7ad9e;
			flex: 0 0 auto;
		}
		#${PANEL_ID} .ocp-stat-value {
			color: #f1e8d7;
			overflow-wrap: anywhere;
		}
		#${PANEL_ID} .ocp-team {
			display: block;
			margin-top: 5px;
		}
		#${PANEL_ID} .ocp-team-title {
			display: flex;
			align-items: baseline;
			justify-content: space-between;
			gap: 5px;
			color: #b7ad9e;
			font-weight: 700;
			margin-bottom: 3px;
		}
		#${PANEL_ID} .ocp-team-summary {
			min-width: 0;
			text-align: right;
			font-size: 10px;
			font-weight: 400;
			color: #c8beae;
		}
		#${PANEL_ID} .ocp-team-chips {
			display: grid;
			grid-template-columns: repeat(3, minmax(0, 1fr));
			gap: 3px;
		}
		#${PANEL_ID} .ocp-team-chip {
			display: block;
			min-width: 0;
			border: 1px solid #42321a;
			background: rgba(9, 10, 10, 0.72);
			border-radius: 5px;
			padding: 2px 4px;
			overflow: hidden;
		}
		#${PANEL_ID} .ocp-team-chip.you {
			border-color: #69a45d;
			background: rgba(25, 48, 23, 0.78);
		}
		#${PANEL_ID} .ocp-team-chip.current {
			border-color: #8d6c25;
		}
		#${PANEL_ID} .ocp-team-chip.forced {
			border-color: #b88725;
			background: rgba(60, 39, 8, 0.78);
		}
		#${PANEL_ID} .ocp-team-chip.open {
			border-style: dashed;
			background: rgba(8, 8, 8, 0.42);
		}
		#${PANEL_ID} .ocp-chip-slot {
			display: block;
			color: #b7ad9e;
			font-size: 10px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} .ocp-chip-member {
			display: block;
			color: #f1e8d7;
			font-size: 11px;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} .ocp-team-chip.you .ocp-chip-member {
			color: #baf0ad;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-chip-flag {
			display: inline-flex;
			color: #d5c8b4;
			font-size: 10px;
			font-weight: 700;
			text-transform: uppercase;
		}
		#${PANEL_ID} .ocp-chip-flags {
			display: flex;
			flex-wrap: wrap;
			gap: 2px 4px;
		}
		#${PANEL_ID} .ocp-chip-flag.joined {
			color: #aee3a5;
		}
		#${PANEL_ID} .ocp-chip-flag.forced {
			color: #ffd98b;
		}
		#${PANEL_ID} .ocp-chip-flag.open {
			color: #aaa39a;
		}
		#${PANEL_ID} .ocp-flexible {
			margin-top: 6px;
			border: 1px solid #765a22;
			border-radius: 7px;
			background: rgba(38, 28, 9, 0.62);
			overflow: hidden;
		}
		#${PANEL_ID} .ocp-flexible summary {
			cursor: pointer;
			padding: 6px;
			font-weight: 700;
			color: #f0d48d;
		}
		#${PANEL_ID} .ocp-cpr-details summary {
			padding: 5px 6px;
		}
		#${PANEL_ID} .ocp-flexible-body {
			padding: 0 6px 6px;
		}
		#${PANEL_ID} .ocp-flexible-note {
			margin-bottom: 4px;
			font-size: 11px;
		}
		#${PANEL_ID} .ocp-flexible-item {
			padding: 5px 0;
			border-top: 1px solid rgba(118, 90, 34, 0.58);
		}
		#${PANEL_ID} .ocp-flexible-item:first-of-type {
			border-top: 0;
		}
		#${PANEL_ID} .ocp-cpr-crime-link {
			display: block;
		}
		#${PANEL_ID} .ocp-cpr-crime-head {
			display: flex;
			align-items: center;
			justify-content: space-between;
			gap: 6px;
		}
		#${PANEL_ID} .ocp-cpr-crime-name {
			min-width: 0;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		#${PANEL_ID} .ocp-cpr-role-row {
			display: flex;
			align-items: center;
			gap: 4px;
			margin-top: 4px;
			overflow-x: auto;
			padding-bottom: 2px;
			scrollbar-width: thin;
		}
		#${PANEL_ID} .ocp-cpr-role-chip {
			display: inline-flex;
			align-items: baseline;
			gap: 4px;
			flex: 0 0 auto;
			padding: 2px 5px;
			border: 1px solid rgba(173, 214, 157, 0.38);
			border-radius: 5px;
			background: rgba(9, 24, 11, 0.58);
			color: #e8f5e4;
			font-size: 10px;
			font-weight: 700;
			white-space: nowrap;
		}
		#${PANEL_ID} .ocp-cpr-role-chip strong {
			color: #b8efa7;
		}
		#${PANEL_ID} .ocp-cpr-role-requirement {
			color: #b7ad9e;
			font-weight: 400;
		}
		#${PANEL_ID} .ocp-cpr-link-meta {
			display: flex;
			justify-content: space-between;
			gap: 6px;
			margin-top: 3px;
			color: #c7d8c1;
			font-size: 10px;
			font-weight: 400;
		}
		#${PANEL_ID} .ocp-disclosure {
			margin-top: 8px;
			border: 1px solid #4a3718;
			background: rgba(13, 12, 10, 0.8);
			color: #f1e8d7;
			border-radius: 8px;
			overflow: hidden;
		}
		#${PANEL_ID} .ocp-disclosure summary {
			cursor: pointer;
			padding: 8px;
			color: #f2d890;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-disclosure table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
			background: rgba(7, 7, 6, 0.72);
		}
		#${PANEL_ID} .ocp-disclosure th,
		#${PANEL_ID} .ocp-disclosure td {
			border-top: 1px solid #3b2c17;
			padding: 6px;
			text-align: left;
			vertical-align: top;
			color: #f1e8d7;
		}
		#${PANEL_ID} .ocp-disclosure th {
			width: 38%;
			color: #cdbb98;
			font-weight: 700;
		}
		#${PANEL_ID} .ocp-privacy-actions {
			display: flex;
			justify-content: flex-end;
			padding: 6px;
			border-top: 1px solid #3b2c17;
		}
		@media (max-width: 520px) {
			.${JOIN_CUE_BADGE_CLASS} {
				max-width: 52vw;
				padding: 2px 5px;
				font-size: 10px;
			}
			#${PANEL_ID} {
				right: 8px;
				bottom: 8px;
				width: calc(100vw - 16px);
				max-width: calc(100% - 16px);
				max-height: min(60vh, calc(100vh - 16px));
				font-size: 11px;
			}
			#${PANEL_ID}.collapsed {
				width: min(210px, calc(100vw - 16px));
			}
			#${PANEL_ID} .ocp-header {
				min-height: 34px;
				padding: 4px 6px;
			}
			#${PANEL_ID} .ocp-icon-button {
				width: 26px;
				height: 26px;
				font-size: 14px;
			}
			#${PANEL_ID} .ocp-body {
				padding: 8px;
				max-height: calc(min(60vh, 100vh - 16px) - 39px);
			}
			#${PANEL_ID} .ocp-row {
				gap: 5px;
				margin-top: 6px;
			}
			#${PANEL_ID} .ocp-toolbar {
				grid-template-columns: auto minmax(0, 1fr);
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
			#${PANEL_ID} .ocp-cpr-overview {
				padding: 5px 6px;
			}
			#${PANEL_ID} .ocp-team-chips {
				grid-template-columns: repeat(2, minmax(0, 1fr));
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

	registerMenuCommand("OC Planner: refresh", () => refreshRecommendations(true));
	registerMenuCommand("OC Planner: forget API key", () => {
		stopHighlightLock();
		storage.remove(STORAGE_KEY);
		storage.remove(PROFILE_STORAGE_KEY);
		storage.remove(PAYLOAD_STORAGE_KEY);
		state.profile = null;
		state.lastPlanner = null;
		state.lastPayload = null;
		state.lastCheckedAt = 0;
		state.lastAttemptAt = 0;
		state.snapshotRevision = "";
		state.usingCachedPayload = false;
		state.takenRecommendationKeys.clear();
		state.targetFeedback = null;
		state.flexibleOpen = false;
		state.error = "";
		state.progress = "";
		state.disclosureOpen = false;
		render();
	});
	registerMenuCommand("OC Planner: reset position", () => {
		storage.remove(POSITION_STORAGE_KEY);
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		panel.style.left = "";
		panel.style.top = "";
		panel.style.right = "";
		panel.style.bottom = "";
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
						let errorPayload = null;
						try {
							errorPayload = JSON.parse(response.responseText || "null");
						} catch {}
						const detail = String(errorPayload?.error || errorPayload?.message || "").trim();
						const requestError = new Error(
							`${options.label || "Request"} failed with HTTP ${status}${detail ? `: ${detail}` : "."}`
						);
						requestError.status = status;
						requestError.code = String(errorPayload?.code || "");
						reject(requestError);
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

	const getLatestPlanner = async (factionId, revision = "", force = false) => {
		const currentFactionId = String(factionId || "").trim();
		if (!currentFactionId) {
			throw new Error("Your Torn profile does not currently show a faction.");
		}
		const encodedFactionId = encodeURIComponent(currentFactionId);
		try {
			const params = new URLSearchParams({ timestamp: String(Date.now()) });
			if (!force && revision) params.set("revision", revision);
			const payload = await requestJson({
				url: getBackendApiUrl(`/api/v1/factions/${encodedFactionId}/oc-planner/bot-alerts?${params.toString()}`),
				label: "OC Planner snapshot request",
			});
			const recommendationPolicy = payload?.recommendationPolicy || {};
			const plannerRefreshRequired = recommendationPolicy.plannerRefreshRequired === true;
			const runtimeStatus = String(recommendationPolicy.runtimeStatus || "");
			const unchanged = payload?.notModified === true;
			const snapshotAvailable = unchanged
				? String(recommendationPolicy.snapshotSource || "") !== "missing"
				: !!payload?.planner;
			return {
				planner: payload?.planner || null,
				unchanged,
				revision: String(payload?.revision || revision || ""),
				status: plannerRefreshRequired
					? runtimeStatus === "plan_failed"
						? "failed"
						: runtimeStatus === "plan_stale" ? "stale" : "refreshing"
					: snapshotAvailable ? "ready" : "missing",
				recommendationPolicy: {
					mode: recommendationPolicy.mode === "cpr" ? "cpr" : "plan",
					plannerGenerationEnabled: recommendationPolicy.plannerGenerationEnabled !== false,
					plannerRefreshRequired,
					updatedAt: recommendationPolicy.updatedAt || null,
					runtimeStatus,
					runtimeMessage: String(recommendationPolicy.runtimeMessage || ""),
					runtimeError: String(recommendationPolicy.runtimeError || ""),
					snapshotSource: String(recommendationPolicy.snapshotSource || ""),
					snapshotGeneratedAt: recommendationPolicy.snapshotGeneratedAt || null,
					cprSnapshotStatus: String(recommendationPolicy.cprSnapshotStatus || ""),
					cprSnapshotGeneratedAt: recommendationPolicy.cprSnapshotGeneratedAt || null,
					cprSnapshotError: String(recommendationPolicy.cprSnapshotError || ""),
					cprRequirements:
						recommendationPolicy.cprRequirements &&
						typeof recommendationPolicy.cprRequirements === "object"
							? recommendationPolicy.cprRequirements
							: {},
				},
			};
		} catch (error) {
			if (
				(Number(error?.status) === 401 || Number(error?.status) === 403) &&
				["AUTH_REQUIRED", "MODULE_DISABLED"].includes(String(error?.code || ""))
			) {
				return {
					planner: null,
					unchanged: false,
					revision: "",
					status: "unavailable",
					recommendationPolicy: {
						mode: "plan",
						plannerGenerationEnabled: true,
						plannerRefreshRequired: false,
						cprRequirements: {},
					},
				};
			}
			throw error;
		}
	};

	const getProfileFactionId = (profile) =>
		profile?.faction?.faction_id ||
		profile?.faction?.id ||
		profile?.faction_id ||
		"";

	const getPlannerFactionId = (profile) => String(getProfileFactionId(profile) || "").trim();

	const recordScriptAccess = async (profile, planner) => {
		const playerId = Number(profile?.player_id || 0);
		if (!playerId) return false;
		const factionId = getPlannerFactionId(profile);
		const payload = {
			playerId,
			name: profile?.name || "",
			factionId: getProfileFactionId(profile),
			scriptVersion: SCRIPT_VERSION,
			plannerGeneratedAt: planner?.generatedAt,
			plannerRunId: planner?.id,
		};
		try {
			await requestJson({
				method: "POST",
				url: getBackendApiUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/oc-planner/script-access`),
				headers: { "Content-Type": "application/json" },
				data: JSON.stringify(payload),
				label: "OC Planner access check-in",
				timeout: 4000,
			});
			return true;
		} catch (error) {
			try {
				const params = new URLSearchParams();
				for (const [key, value] of Object.entries(payload)) {
					if (value === undefined || value === null || value === "") continue;
					params.set(key, String(value));
				}
				await requestJson({
					url: getBackendApiUrl(`/api/v1/factions/${encodeURIComponent(factionId)}/oc-planner/script-access?${params.toString()}`),
					label: "OC Planner access check-in fallback",
					timeout: 4000,
				});
				return true;
			} catch (fallbackError) {
				console.warn(
					"OC Planner access check-in failed:",
					fallbackError?.message || error?.message || fallbackError || error
				);
				return false;
			}
		}
	};

	const recordScriptAccessIfNeeded = async (profile, planner) => {
		const playerId = Number(profile?.player_id || 0);
		const factionId = getPlannerFactionId(profile);
		if (!playerId || !factionId) return;
		const signature = [
			SCRIPT_VERSION,
			factionId,
			playerId,
			planner?.id || "",
			planner?.generatedAt || "",
		].join(":");
		let previous = null;
		try {
			previous = JSON.parse(String(storage.get(SCRIPT_ACCESS_STORAGE_KEY, "") || "null"));
		} catch {
			previous = null;
		}
		const recordedAt = Number(previous?.recordedAt || 0);
		if (
			previous?.signature === signature &&
			Number.isFinite(recordedAt) &&
			Date.now() - recordedAt < SCRIPT_ACCESS_INTERVAL_MS
		) {
			return;
		}
		if (await recordScriptAccess(profile, planner)) {
			storage.set(
				SCRIPT_ACCESS_STORAGE_KEY,
				JSON.stringify({ signature, recordedAt: Date.now() })
			);
		}
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
			const savedAt = Date.parse(String(cached.savedAt || ""));
			if (!Number.isFinite(savedAt) || Date.now() - savedAt > PROFILE_CACHE_MAX_AGE_MS) return null;
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

	const getCachedMemberPayload = (key) => {
		const keyCacheId = getKeyCacheId(key);
		if (!keyCacheId) return null;
		try {
			const cached = JSON.parse(String(storage.get(PAYLOAD_STORAGE_KEY, "") || ""));
			if (
				![1, 2].includes(Number(cached?.schemaVersion)) ||
				cached?.keyCacheId !== keyCacheId ||
				!cached?.payload?.memberId
			) {
				return null;
			}
			return cached;
		} catch {
			return null;
		}
	};

	const saveCachedMemberPayload = (key, profile, payload, checkedAt, snapshotRevision = "") => {
		const factionId = getPlannerFactionId(profile);
		if (!key || !payload?.memberId || !factionId) return;
		try {
			storage.set(
				PAYLOAD_STORAGE_KEY,
				JSON.stringify({
					schemaVersion: 2,
					keyCacheId: getKeyCacheId(key),
					memberId: payload.memberId,
					factionId,
					checkedAt,
					snapshotRevision: String(snapshotRevision || ""),
					payload,
				})
			);
		} catch (error) {
			console.warn("OC Planner member cache could not be saved:", error);
		}
	};

	const hydrateCachedMemberPayload = (key, profile) => {
		const cached = getCachedMemberPayload(key);
		if (!cached) return false;
		const memberId = Number(profile?.player_id || 0);
		const factionId = getPlannerFactionId(profile);
		if (
			!memberId ||
			!factionId ||
			Number(cached.memberId || cached.payload?.memberId || 0) !== memberId ||
			String(cached.factionId || "").trim() !== factionId
		) {
			clearCachedMemberPayload();
			return false;
		}
		state.lastPayload = { ...cached.payload, factionId };
		state.lastCheckedAt = Number(cached.checkedAt || 0);
		state.snapshotRevision = String(cached.snapshotRevision || "");
		state.usingCachedPayload = true;
		return true;
	};

	const clearCachedMemberPayload = () => {
		storage.remove(PAYLOAD_STORAGE_KEY);
		state.lastCheckedAt = 0;
		state.snapshotRevision = "";
		state.usingCachedPayload = false;
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
		clearRecommendationJoinCues();
		clearRecommendationHighlights();
		clearCprEligibilityHighlights();
		lastRenderedMarkup = "";
		state.pendingHighlight = null;
		state.targetFeedback = null;
		state.highlightObserver?.disconnect();
		state.highlightObserver = null;
		state.highlightRetryQueued = false;
		if (state.autoRefreshTimer) {
			window.clearTimeout(state.autoRefreshTimer);
			state.autoRefreshTimer = undefined;
		}
	};

	const getStoredPanelPosition = () => {
		const raw = storage.get(POSITION_STORAGE_KEY, "");
		if (!raw) return null;

		try {
			const position = JSON.parse(String(raw));
			const left = Number(position?.left);
			const top = Number(position?.top);
			if (Number.isFinite(left) && Number.isFinite(top)) return { left, top };
		} catch {}

		storage.remove(POSITION_STORAGE_KEY);
		return null;
	};

	const savePanelPosition = (position) => {
		storage.set(
			POSITION_STORAGE_KEY,
			JSON.stringify({
				left: Math.round(position.left),
				top: Math.round(position.top),
			})
		);
	};

	const clampPanelPosition = (panel, left, top) => {
		const width = panel.offsetWidth || panel.getBoundingClientRect().width || 340;
		const height = panel.offsetHeight || panel.getBoundingClientRect().height || 80;
		const maxLeft = Math.max(PANEL_EDGE_GAP, window.innerWidth - width - PANEL_EDGE_GAP);
		const maxTop = Math.max(PANEL_EDGE_GAP, window.innerHeight - height - PANEL_EDGE_GAP);

		return {
			left: Math.min(Math.max(PANEL_EDGE_GAP, left), maxLeft),
			top: Math.min(Math.max(PANEL_EDGE_GAP, top), maxTop),
		};
	};

	const setPanelPosition = (panel, position, persist = false) => {
		if (!panel || !position) return;
		const clamped = clampPanelPosition(panel, position.left, position.top);
		panel.style.left = `${clamped.left}px`;
		panel.style.top = `${clamped.top}px`;
		panel.style.right = "auto";
		panel.style.bottom = "auto";
		if (persist) savePanelPosition(clamped);
	};

	const applyStoredPanelPosition = () => {
		const panel = document.getElementById(PANEL_ID);
		const position = getStoredPanelPosition();
		if (panel && position) setPanelPosition(panel, position);
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
			return `${message} Check profile access.`;
		}
		if (lower.includes("oc planner snapshot") || lower.includes("saved oc planner") || lower.includes("backend")) {
			return `${message} Planner service unavailable.`;
		}
		if (lower.includes("expected json")) {
			return `${message} Invalid backend route.`;
		}
		if (lower.includes("timed out") || lower.includes("network")) {
			return `${message} Check your connection.`;
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
	const ROLE_TITLE_SELECTOR =
		"[class*='slotHeader'] [class*='title'], [class*='slotHeader'], [class*='SlotHeader'] [class*='title'], [class*='SlotHeader'], [class*='slot'] [class*='title'], [class*='Slot'] [class*='title']";
	const CRIME_ID_SELECTOR =
		"a[href], button, [data-crime-id], [data-crimeid], [data-oc-id], [data-id]";

	const getRoleTerms = (recommendation) =>
		[
			recommendation?.position,
			recommendation?.role,
		]
			.map(normalizeText)
			.filter(Boolean);

	const getPositionRoleHint = (recommendation) => {
		const position = normalizeText(recommendation?.position);
		const match = position.match(/^(.+?)\s*#\s*(\d+)$/);
		if (!match) return null;
		const role = normalizeText(match[1]);
		const ordinal = Number(match[2]);
		return role && Number.isInteger(ordinal) && ordinal > 0 ? { role, ordinal } : null;
	};

	const getRoleCandidateWrapper = (element) =>
		element?.closest("[class*='wrapper'], [class*='slot'], [class*='Slot'], li, tr, [role='row']") ||
		element ||
		null;

	const getRoleTitleText = (element) =>
		normalizeText(element?.querySelector?.("[class*='title']")?.textContent || element?.textContent);

	const findExactRoleTitleElement = (scope, recommendation) => {
		const roleTerms = getRoleTerms(recommendation);
		if (!roleTerms.length) return null;
		const root = scope || document;
		const seenWrappers = new Set();
		const entries = Array.from(
			root.querySelectorAll(ROLE_TITLE_SELECTOR)
		)
			.filter((element) => !isInsidePanel(element))
			.map((element) => ({
				text: getRoleTitleText(element),
				wrapper: getRoleCandidateWrapper(element),
			}))
			.filter((entry) => {
				if (!entry.text || !entry.wrapper || seenWrappers.has(entry.wrapper)) return false;
				seenWrappers.add(entry.wrapper);
				return true;
			});

		const positionHint = getPositionRoleHint(recommendation);
		if (positionHint) {
			const exactPosition = normalizeText(recommendation?.position);
			const exactPositionMatch = entries.find((entry) => entry.text === exactPosition);
			if (exactPositionMatch) return exactPositionMatch.wrapper;
			const ordinalMatches = entries.filter(
				(entry) => entry.text === positionHint.role || entry.text.startsWith(`${positionHint.role} `)
			);
			return ordinalMatches[positionHint.ordinal - 1]?.wrapper || null;
		}

		const exactMatch = entries.find((entry) => roleTerms.some((term) => entry.text === term));
		if (exactMatch) return exactMatch.wrapper;

		return entries.find((entry) => roleTerms.some((term) => entry.text.startsWith(`${term} `)))?.wrapper || null;
	};

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

	const getCurrentPageCrimeId = () => {
		try {
			const parsed = new URL(window.location.href);
			const hashParams = new URLSearchParams(parsed.hash.replace(/^#\/?/, ""));
			return String(
				parsed.searchParams.get("crimeId") ||
					parsed.searchParams.get("crimeID") ||
					hashParams.get("crimeId") ||
					hashParams.get("crimeID") ||
					""
			);
		} catch {
			return "";
		}
	};

	const getCrimeIdsWithin = (element) => {
		if (!element) return new Set();
		const candidates = [element, ...element.querySelectorAll(CRIME_ID_SELECTOR)];
		return new Set(candidates.map(getElementCrimeId).filter(Boolean));
	};

	const getCrimeContainer = (element, crimeId, recommendation) => {
		const id = String(crimeId || "");
		let current = element;
		while (current && current !== document.body && current !== document.documentElement) {
			const crimeIds = getCrimeIdsWithin(current);
			const roleElement = findExactRoleTitleElement(current, recommendation);
			if (
				crimeIds.size === 1 &&
				crimeIds.has(id) &&
				roleElement &&
				(roleElement === current || current.contains(roleElement))
			) {
				return current;
			}
			current = current.parentElement;
		}
		return null;
	};

	const isVisibleElement = (element) =>
		!!element?.isConnected &&
		(typeof element.getClientRects !== "function" || element.getClientRects().length > 0);

	const isInsidePanel = (element) => !!element?.closest?.(`#${PANEL_ID}`);

	const findCrimeElement = (crimeId, recommendation, requireActiveCrime = true) => {
		const id = String(crimeId || "");
		if (!id) return null;
		const activeCrimeId = getCurrentPageCrimeId();
		if (requireActiveCrime && activeCrimeId && activeCrimeId !== id) return null;

		const candidates = Array.from(
			document.querySelectorAll(CRIME_ID_SELECTOR)
		).filter((element) => !isInsidePanel(element) && getElementCrimeId(element) === id);
		const seen = new Set();
		const containers = candidates
			.map((element) => getCrimeContainer(element, id, recommendation))
			.filter((element) => {
				if (!element || seen.has(element)) return false;
				seen.add(element);
				return true;
			});

		return containers.find(isVisibleElement) || containers[0] || null;
	};

	const findRoleElement = (crimeElement, recommendation) => {
		if (!crimeElement || !recommendation) return null;
		const isWithinCrime = (element) =>
			!!element && (element === crimeElement || crimeElement.contains(element));
		const exactTitleMatch = findExactRoleTitleElement(crimeElement, recommendation);
		if (isWithinCrime(exactTitleMatch)) return exactTitleMatch;
		if (getPositionRoleHint(recommendation)) return null;

		const roleTerms = getRoleTerms(recommendation);
		if (!roleTerms.length) return null;

		const candidates = Array.from(
			crimeElement.querySelectorAll(
				"li, tr, [role='row'], [class*='slot'], [class*='Slot'], [class*='role'], [class*='Role'], [class*='member'], [class*='Member'], button, a"
			)
		).filter((element) => !isInsidePanel(element));

		const match = candidates
			.filter((element) => element !== crimeElement)
			.sort((a, b) => normalizeText(a.textContent).length - normalizeText(b.textContent).length)
			.find((element) => {
				const text = normalizeText(element.textContent);
				return text && roleTerms.some((term) => text.includes(term));
			});

		const wrapper =
			match?.closest("li, tr, [role='row'], [class*='slot'], [class*='Slot'], [class*='role'], [class*='Role']") ||
			match ||
			null;
		return isWithinCrime(wrapper) ? wrapper : null;
	};

	const clearRecommendationHighlights = () => {
		document
			.querySelectorAll(".askeladds-oc-planner-highlight")
			.forEach((element) => element.classList.remove("askeladds-oc-planner-highlight"));
		document
			.querySelectorAll(".askeladds-oc-planner-role-highlight")
			.forEach((element) => {
				element.classList.remove("askeladds-oc-planner-role-highlight");
				element.classList.remove("askeladds-oc-planner-role-filled");
			});
	};

	const clearCprEligibilityHighlights = () => {
		document
			.querySelectorAll(`.${CPR_ELIGIBLE_ROLE_CLASS}`)
			.forEach((element) => element.classList.remove(CPR_ELIGIBLE_ROLE_CLASS));
	};

	const syncCprEligibilityHighlights = () => {
		const payload = state.lastPayload;
		if (
			!state.active ||
			!isOcCrimesPage() ||
			payload?.noPlan ||
			payload?.recommendationMode !== "cpr"
		) {
			clearCprEligibilityHighlights();
			return;
		}

		const eligibleSlots = (payload.cprEligibleSlots || []).filter(
			(slot) => !state.takenRecommendationKeys.has(getRecommendationKey(slot))
		);
		const desiredElements = new Set();
		for (const slots of groupCprSlotsByCrime(eligibleSlots)) {
			let crimeElement = null;
			for (const slot of slots) {
				crimeElement = findCrimeElement(slot.crimeId, slot, false);
				if (crimeElement) break;
			}
			if (!crimeElement) continue;

			const matchedRoleElements = new Set();
			for (const slot of slots) {
				const roleElement = findRoleElement(crimeElement, slot);
				if (!roleElement || matchedRoleElements.has(roleElement)) continue;
				matchedRoleElements.add(roleElement);
				if (inspectRoleAvailability(roleElement).kind !== "found") continue;
				desiredElements.add(roleElement);
			}
		}

		document.querySelectorAll(`.${CPR_ELIGIBLE_ROLE_CLASS}`).forEach((element) => {
			if (!desiredElements.has(element)) element.classList.remove(CPR_ELIGIBLE_ROLE_CLASS);
		});
		desiredElements.forEach((element) => element.classList.add(CPR_ELIGIBLE_ROLE_CLASS));
	};

	const clearRecommendationJoinCues = () => {
		document
			.querySelectorAll(`.${JOIN_CUE_BADGE_CLASS}`)
			.forEach((element) => element.remove());
	};

	const getRecommendationJoinCue = (recommendations, index) => {
		const recommendation = recommendations[index];
		if (!recommendation) return "";
		const role = recommendation.position || recommendation.role || "assigned role";
		const prefix = `Join as ${role}`;
		if (index === 0) {
			if (recommendation.currentCrimeName) {
				return `${prefix} after ${recommendation.currentCrimeName}`;
			}
			if (
				recommendation.availableAt &&
				recommendation.availableAt > Math.floor(Date.now() / 1000)
			) {
				return `${prefix} when free`;
			}
			return `${prefix} now`;
		}

		const previous = recommendations[index - 1];
		return `${prefix} after ${previous?.crimeName || `OC #${previous?.crimeId || "?"}`}`;
	};

	const getRecommendationKey = (recommendation) =>
		`${String(recommendation?.crimeId || "")}|${normalizeText(
			recommendation?.position || recommendation?.role
		)}`;

	const getHighlightRecommendations = (recommendation) =>
		Array.isArray(recommendation?.eligibleRoles)
			? recommendation.eligibleRoles
			: recommendation
				? [recommendation]
				: [];

	const getHighlightRecommendationKey = (recommendation) => {
		const roles = getHighlightRecommendations(recommendation)
			.map((role) => normalizeText(role.position || role.role))
			.filter(Boolean)
			.sort();
		return `${String(recommendation?.crimeId || "")}|${roles.join("+")}`;
	};

	const getHighlightRoleLabel = (recommendation) =>
		String(recommendation?.position || recommendation?.role || "role");

	const groupCprSlotsByCrime = (slots) => {
		const groups = new Map();
		for (const slot of slots) {
			const crimeId = String(slot?.crimeId || "");
			if (!crimeId) continue;
			if (!groups.has(crimeId)) groups.set(crimeId, []);
			groups.get(crimeId).push(slot);
		}
		return Array.from(groups.values());
	};

	const getRecommendationBadgeState = (recommendations, index, crimeElement) => {
		const recommendation = recommendations[index];
		const role = recommendation?.position || recommendation?.role || "assigned role";
		const roleElement = findRoleElement(crimeElement, recommendation);
		const availability = roleElement ? inspectRoleAvailability(roleElement) : null;

		if (availability?.kind === "joined") {
			return {
				kind: "joined",
				label: `Joined as ${role}`,
				status: "You are already in this role",
			};
		}
		if (availability?.kind === "filled") {
			return {
				kind: "filled",
				label: `Role filled: ${role}`,
				status: availability.occupant?.name
					? `Filled by ${availability.occupant.name}`
					: "Filled by another player",
			};
		}

		const isHighlightedTarget =
			getRecommendationKey(state.lastHighlightRecommendation) ===
			getRecommendationKey(recommendation);
		const feedbackKind = isHighlightedTarget ? state.targetFeedback?.kind : "";
		if (feedbackKind === "opening") {
			return { kind: "opening", label: `Opening: ${role}`, status: "Opening exact OC" };
		}
		if (feedbackKind === "found") {
			return { kind: "found", label: `Role found: ${role}`, status: "Exact OC and role found" };
		}
		if (feedbackKind === "joined") {
			return { kind: "joined", label: `Joined as ${role}`, status: "You are already in this role" };
		}
		if (feedbackKind === "filled") {
			return { kind: "filled", label: `Role filled: ${role}`, status: "Role already filled" };
		}
		if (feedbackKind === "missing") {
			return { kind: "missing", label: `Could not find: ${role}`, status: "Exact OC or role not found" };
		}

		return {
			kind: "planned",
			label: getRecommendationJoinCue(recommendations, index),
			status: "Planned assignment",
		};
	};

	const getRecommendationTooltip = (recommendations, index, badgeState) => {
		const recommendation = recommendations[index];
		if (!recommendation) return "";
		const phase = index === 0 ? "Next" : "Then";
		const crimeName = recommendation.crimeName || "Organized crime";
		const crimeId = recommendation.crimeId || "?";
		const role = recommendation.position || recommendation.role || "assigned role";
		const lines = [
			`${phase} assignment`,
			`Target: ${crimeName} (OC #${crimeId})`,
			`Role: ${role}`,
		];

		if (index === 0 && recommendation.currentCrimeName) {
			const currentId = recommendation.currentCrimeId
				? ` (OC #${recommendation.currentCrimeId})`
				: "";
			lines.push(`After: ${recommendation.currentCrimeName}${currentId}`);
		} else if (index > 0) {
			const previous = recommendations[index - 1];
			lines.push(
				`After: ${previous?.crimeName || "previous assignment"}${
					previous?.crimeId ? ` (OC #${previous.crimeId})` : ""
				}`
			);
		} else if (
			recommendation.availableAt &&
			recommendation.availableAt > Math.floor(Date.now() / 1000)
		) {
			lines.push(`Available: ${formatTimestamp(recommendation.availableAt)}`);
		} else {
			lines.push("Available: now");
		}

		if (recommendation.plannedJoinAt) {
			lines.push(`Planned join: ${formatTimestamp(recommendation.plannedJoinAt)}`);
		}
		if (recommendation.plannedStartAt) {
			lines.push(`Planned start: ${formatTimestamp(recommendation.plannedStartAt)}`);
		}
		lines.push(`Status: ${badgeState.status}`);
		return lines.join("\n");
	};

	const updateRecommendationJoinCue = (badge, item, recommendations, crimeElement) => {
		const badgeState = getRecommendationBadgeState(
			recommendations,
			item.index,
			crimeElement
		);
		const className = `${JOIN_CUE_BADGE_CLASS} ${badgeState.kind}`;
		const title = getRecommendationTooltip(recommendations, item.index, badgeState);
		if (badge.className !== className) badge.className = className;
		if (badge.textContent !== badgeState.label) badge.textContent = badgeState.label;
		if (badge.title !== title) badge.title = title;
	};

	const findCrimeTitleElement = (crimeElement, crimeName) => {
		const target = normalizeText(crimeName);
		if (!crimeElement || !target) return null;
		return (
			Array.from(
				crimeElement.querySelectorAll(
					"h1, h2, h3, h4, h5, h6, [class*='title'], [class*='Title'], [class*='name'], [class*='Name'], span"
				)
			)
				.filter(
					(element) =>
						!isInsidePanel(element) &&
						!element.classList.contains(JOIN_CUE_BADGE_CLASS) &&
						normalizeText(element.textContent) === target
				)
				.sort((a, b) => a.children.length - b.children.length)[0] ||
			null
		);
	};

	const syncRecommendationJoinCues = () => {
		const recommendations = state.lastPayload?.recommendations || [];
		if (!state.active || !isOcCrimesPage() || !recommendations.length) {
			clearRecommendationJoinCues();
			return;
		}

		const desired = new Map();
		recommendations.forEach((recommendation, index) => {
			const crimeId = String(recommendation.crimeId || "");
			if (!crimeId || desired.has(crimeId)) return;
			desired.set(crimeId, {
				recommendation,
				index,
			});
		});

		const existingByCrimeId = new Map();
		document.querySelectorAll(`.${JOIN_CUE_BADGE_CLASS}`).forEach((badge) => {
			const crimeId = String(badge.dataset.ocpCrimeId || "");
			const item = desired.get(crimeId);
			if (!item || existingByCrimeId.has(crimeId)) {
				badge.remove();
				return;
			}
			const crimeElement = findCrimeElement(crimeId, item.recommendation, false);
			if (!crimeElement) {
				badge.remove();
				return;
			}
			updateRecommendationJoinCue(badge, item, recommendations, crimeElement);
			existingByCrimeId.set(crimeId, badge);
		});

		for (const [crimeId, item] of desired) {
			if (existingByCrimeId.has(crimeId)) continue;
			const crimeElement = findCrimeElement(crimeId, item.recommendation, false);
			const titleElement = findCrimeTitleElement(
				crimeElement,
				item.recommendation.crimeName
			);
			if (!titleElement) continue;

			const badge = document.createElement("span");
			badge.className = JOIN_CUE_BADGE_CLASS;
			badge.dataset.ocpCrimeId = crimeId;
			updateRecommendationJoinCue(badge, item, recommendations, crimeElement);
			titleElement.appendChild(badge);
		}
	};

	const syncTargetFeedbackElement = () => {
		const element = document.querySelector(`#${PANEL_ID} .ocp-target-feedback`);
		if (!element) return;
		const feedback = state.targetFeedback;
		element.hidden = !feedback;
		element.className = `ocp-target-feedback ${feedback?.kind || ""}`.trim();
		element.textContent = feedback?.label || "";
		element.title = feedback?.detail || feedback?.label || "";
	};

	const syncHighlightControls = () => {
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		const findButton = panel.querySelector(".ocp-highlight-again");
		const stopButton = panel.querySelector(".ocp-highlight-stop");
		if (findButton) {
			const roleCount = getHighlightRecommendations(state.lastHighlightRecommendation).length;
			findButton.hidden = !state.lastHighlightRecommendation || !!state.pendingHighlight;
			findButton.textContent = roleCount > 1 ? "Find roles" : "Find role";
			findButton.title = roleCount > 1
				? "Find all eligible roles in this OC again"
				: "Find the exact assigned role again";
		}
		if (stopButton) stopButton.hidden = !state.pendingHighlight;
	};

	const setTargetFeedback = (kind, label, detail = "") => {
		state.targetFeedback = label ? { kind, label, detail } : null;
		syncTargetFeedbackElement();
		window.setTimeout(syncRecommendationJoinCues, 0);
	};

	const setRecommendationTaken = (recommendation, taken) => {
		const key = getRecommendationKey(recommendation);
		if (!key || key.startsWith("|")) return;
		const hadKey = state.takenRecommendationKeys.has(key);
		if (taken === hadKey) return;
		if (taken) state.takenRecommendationKeys.add(key);
		else state.takenRecommendationKeys.delete(key);
		window.setTimeout(() => render(), 0);
	};

	const getRoleOccupant = (roleElement) => {
		if (!roleElement) return null;
		const roleScope = roleElement.closest?.("[class*='wrapper'], [class*='Wrapper']") || roleElement;
		const selector =
			"a[href*='profiles.php'], a[href*='XID='], [class*='userName'], [class*='UserName'], [class*='username'], [class*='memberName'], [class*='MemberName'], [class*='playerName']";
		const element = roleScope.querySelector(selector);
		if (!element || element.closest?.("[class*='slotHeader']")) return null;
		const href = element.getAttribute?.("href") || element.closest?.("a[href]")?.getAttribute("href") || "";
		const idMatch = href.match(/[?&#](?:XID|userI?d|playerI?d)=(\d+)/i);
		return {
			id: Number(idMatch?.[1] || 0),
			name: String(element.textContent || "").trim(),
		};
	};

	const inspectRoleAvailability = (roleElement) => {
		const occupant = getRoleOccupant(roleElement);
		if (occupant) {
			const memberId = Number(state.lastPayload?.memberId || state.profile?.player_id || 0);
			const memberName = normalizeText(state.lastPayload?.memberName || state.profile?.name);
			const isYou =
				(occupant.id && memberId && occupant.id === memberId) ||
				(occupant.name && memberName && normalizeText(occupant.name) === memberName);
			if (!isYou) return { kind: "filled", occupant };
			return { kind: "joined", occupant };
		}

		return { kind: "found", occupant };
	};

	const stopHighlightLock = (clearHighlights = true) => {
		state.pendingHighlight = null;
		state.highlightObserver?.disconnect();
		state.highlightObserver = null;
		state.highlightRetryQueued = false;
		if (clearHighlights) clearRecommendationHighlights();
		syncHighlightControls();
	};

	const highlightRecommendation = (recommendationOrCrimeId) => {
		const recommendation =
			typeof recommendationOrCrimeId === "object" && recommendationOrCrimeId
				? recommendationOrCrimeId
				: { crimeId: recommendationOrCrimeId };
		const id = String(recommendation.crimeId || "");
		const roleTargets = getHighlightRecommendations(recommendation);
		if (!id || !roleTargets.length) return { roleFound: false, allRolesFound: false, matches: [] };
		clearRecommendationHighlights();

		let crimeElement = null;
		for (const roleTarget of roleTargets) {
			crimeElement = findCrimeElement(id, roleTarget);
			if (crimeElement) break;
		}
		if (!crimeElement) {
			return {
				roleFound: false,
				allRolesFound: false,
				matches: [],
				missingRecommendations: roleTargets,
			};
		}

		const matches = [];
		const missingRecommendations = [];
		const matchedRoleElements = new Set();
		for (const roleTarget of roleTargets) {
			const roleElement = findRoleElement(crimeElement, roleTarget);
			if (!roleElement || matchedRoleElements.has(roleElement)) {
				missingRecommendations.push(roleTarget);
				continue;
			}
			matchedRoleElements.add(roleElement);
			const availability = inspectRoleAvailability(roleElement);
			roleElement.classList.add("askeladds-oc-planner-role-highlight");
			if (availability.kind === "filled") {
				roleElement.classList.add("askeladds-oc-planner-role-filled");
			}
			matches.push({ recommendation: roleTarget, roleElement, availability });
		}
		if (matches.length && !state.pendingHighlight?.hasScrolled) {
			matches[0].roleElement.scrollIntoView?.({ behavior: "smooth", block: "center" });
			if (state.pendingHighlight) state.pendingHighlight.hasScrolled = true;
		}
		return {
			roleFound: matches.length > 0,
			allRolesFound: matches.length === roleTargets.length,
			matches,
			missingRecommendations,
			availability: matches[0]?.availability,
		};
	};

	const queueHighlightRecommendation = (recommendation) => {
		if (!recommendation?.crimeId || !getHighlightRecommendations(recommendation).length) return;
		const recommendationKey = getHighlightRecommendationKey(recommendation);
		if (state.pendingHighlight?.recommendationKey === recommendationKey) {
			return;
		}
		state.lastHighlightRecommendation = recommendation;
		state.pendingHighlight = {
			recommendation,
			recommendationKey,
			startedAt: Date.now(),
			hasScrolled: false,
		};
		const roleLabels = getHighlightRecommendations(recommendation).map(getHighlightRoleLabel);
		setTargetFeedback(
			"opening",
			"Opening OC",
			roleLabels.length > 1
				? `${recommendation.crimeName || `OC #${recommendation.crimeId}`}: ${roleLabels.join(", ")}`
				: `${recommendation.crimeName || `OC #${recommendation.crimeId}`} / ${roleLabels[0] || "role"}`
		);
		syncHighlightControls();
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
		[0, 100, 250, 500, 900, 1400, 2200, 3200, 4800, 7000, 10000, 14000, 19000, 24000].forEach((delay) => {
			window.setTimeout(() => retryPendingHighlight(), delay);
		});
	};

	const retryPendingHighlight = () => {
		const pending = state.pendingHighlight;
		if (!pending) return;
		const result = highlightRecommendation(pending.recommendation);
		const roleTargets = getHighlightRecommendations(pending.recommendation);
		const groupedTarget = Array.isArray(pending.recommendation?.eligibleRoles);
		if (groupedTarget) {
			for (const match of result.matches || []) {
				setRecommendationTaken(match.recommendation, match.availability?.kind === "filled");
			}
			if (result.roleFound) {
				const openCount = result.matches.filter((match) => match.availability?.kind === "found").length;
				const joinedCount = result.matches.filter((match) => match.availability?.kind === "joined").length;
				const filledCount = result.matches.filter((match) => match.availability?.kind === "filled").length;
				const missingCount = Math.max(0, roleTargets.length - result.matches.length);
				const statusParts = [
					openCount ? `${openCount} open` : "",
					joinedCount ? `${joinedCount} joined` : "",
					filledCount ? `${filledCount} filled` : "",
					missingCount ? `${missingCount} still loading` : "",
				].filter(Boolean);
				setTargetFeedback(
					result.allRolesFound && !joinedCount && !filledCount ? "found" : missingCount ? "opening" : openCount ? "found" : filledCount ? "filled" : "joined",
					result.allRolesFound && !joinedCount && !filledCount
						? `${roleTargets.length} eligible role${roleTargets.length === 1 ? "" : "s"} found`
						: statusParts.join(" | "),
					`${pending.recommendation.crimeName || `OC #${pending.recommendation.crimeId}`}: ${result.matches.map((match) => `${getHighlightRoleLabel(match.recommendation)} (${match.availability?.kind || "found"})`).join(", ")}`
				);
			}
			if (result.allRolesFound && Date.now() - pending.startedAt > 2800) {
				stopHighlightLock(false);
				return;
			}
			if (Date.now() - pending.startedAt > 25000) {
				const missingRoles = (result.missingRecommendations || []).map(getHighlightRoleLabel);
				setTargetFeedback(
					"missing",
					result.matches.length
						? `Found ${result.matches.length} of ${roleTargets.length} eligible roles`
						: "Could not find eligible roles",
					missingRoles.length
						? `Missing: ${missingRoles.join(", ")}. The OC may have changed or still be loading.`
						: "OC not found. It may have changed or still be loading."
				);
				stopHighlightLock(false);
			}
			return;
		}
		if (result.roleFound) {
			const availabilityKind = result.availability?.kind || "found";
			const filled = availabilityKind === "filled";
			const joined = availabilityKind === "joined";
			setRecommendationTaken(pending.recommendation, filled);
			setTargetFeedback(
				filled ? "filled" : joined ? "joined" : "found",
				filled ? "Role already filled" : joined ? "Already joined" : "Role found",
				filled && result.availability?.occupant?.name
					? `Occupied by ${result.availability.occupant.name}.`
					: joined
						? `${pending.recommendation.crimeName || `OC #${pending.recommendation.crimeId}`} / ${pending.recommendation.position || pending.recommendation.role || "role"}`
					: `${pending.recommendation.crimeName || `OC #${pending.recommendation.crimeId}`} / ${pending.recommendation.position || pending.recommendation.role || "role"}`
			);
		}
		if (result.roleFound && Date.now() - pending.startedAt > 2800) {
			stopHighlightLock(false);
			return;
		}
		if (Date.now() - pending.startedAt > 25000) {
			setTargetFeedback(
				"missing",
				"Could not find exact OC/role",
				`${pending.recommendation.crimeName || `OC #${pending.recommendation.crimeId}`} / ${pending.recommendation.position || pending.recommendation.role || "role"} not found.`
			);
			stopHighlightLock(false);
		}
	};

	const getMemberId = (member) =>
		Number(
			member?.memberId ||
				member?.userId ||
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
			member.userName ||
			member.playerName ||
			member.player_name ||
			member.name ||
			member.username ||
			(id ? `Player ${id}` : "")
		);
	};

	const getSlotMember = (slot) => {
		const currentMember =
			slot.currentMember ||
			slot.currentUser ||
			slot.member ||
			slot.user ||
			slot.participant;
		const forcedMember =
			slot.forcedMember ||
			slot.forcedUser ||
			slot.manualMember ||
			slot.manualUser ||
			slot.lockedMember ||
			slot.lockedUser ||
			slot.pinnedMember ||
			slot.pinnedUser ||
			slot.overrideMember ||
			slot.overrideUser;
		const plannedMember =
			forcedMember ||
			slot.expectedMember ||
			slot.plannedMember ||
			slot.assignedMember ||
			slot.recommended ||
			slot.soonRecommended;
		const isForced = !!(
			forcedMember ||
			plannedMember?.forced ||
			currentMember?.forced ||
			slot.forced ||
			slot.isForced ||
			slot.manuallyAssigned ||
			slot.manualAssignment
		);
		const hasCurrentMember = !!(
			currentMember ||
			slot.currentMemberName ||
			slot.currentUserName ||
			slot.currentMemberId ||
			slot.currentUserId
		);
		const currentName =
			getMemberName(currentMember) ||
			slot.currentMemberName ||
			slot.currentUserName ||
			(hasCurrentMember ? slot.memberName || slot.playerName || slot.userName || slot.name : "");
		const plannedName =
			getMemberName(plannedMember) ||
			slot.forcedMemberName ||
			slot.forcedUserName ||
			slot.manualMemberName ||
			slot.manualUserName ||
			slot.lockedMemberName ||
			slot.lockedUserName ||
			slot.pinnedMemberName ||
			slot.pinnedUserName ||
			slot.overrideMemberName ||
			slot.overrideUserName ||
			slot.expectedMemberName ||
			slot.plannedMemberName ||
			slot.assignedMemberName;
		const fallbackName = slot.memberName || slot.playerName || slot.userName || slot.name;
		const name = currentName || plannedName || fallbackName;
		const currentId =
			getMemberId(currentMember) ||
			Number(
				slot.currentMemberId ||
					slot.currentUserId ||
					(hasCurrentMember ? slot.memberId || slot.playerId || slot.userId : 0) ||
					0
			);
		const plannedId =
			getMemberId(plannedMember) ||
			Number(
				slot.forcedMemberId ||
					slot.forcedUserId ||
					slot.manualMemberId ||
					slot.manualUserId ||
					slot.lockedMemberId ||
					slot.lockedUserId ||
					slot.pinnedMemberId ||
					slot.pinnedUserId ||
					slot.overrideMemberId ||
					slot.overrideUserId ||
					slot.expectedMemberId ||
					slot.plannedMemberId ||
					slot.assignedMemberId ||
					0
			);
		const id = currentId || plannedId || Number(slot.memberId || slot.playerId || slot.userId || 0);
		const hasAssignment = !!(id || currentName || plannedName || fallbackName);
		return {
			id,
			name: hasAssignment ? name || (id ? `Player ${id}` : "Planned member") : "Open",
			hasAssignment,
			isCurrent: hasCurrentMember,
			isForced,
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
				isOpen: !member.hasAssignment,
				isCurrent: member.isCurrent,
				isForced: member.isForced,
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
				const crimeId = crime.id || slot.crimeId || recommended.crimeId;

				recommendations.push({
					type: "slot",
					crimeId,
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
					plannedJoinAt: slot.plannedJoinAt,
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

	const getSlotCprBand = (slot, crime, cprRequirements = {}) => {
		const fallbackMin = Number(slot?.minimumRecommendedCpr || 0);
		const fallbackMax = Number(slot?.maximumRecommendedCpr || 100);
		const impact = ["high", "medium", "low", "unknown"].includes(slot?.roleImpactLabel)
			? slot.roleImpactLabel
			: "unknown";
		const numericDifficulty = Number(crime?.difficulty || 0);
		const difficulty = Number.isFinite(numericDifficulty) && numericDifficulty > 0
			? String(Math.max(1, Math.min(10, Math.round(numericDifficulty))))
			: "";
		const configured = difficulty ? cprRequirements?.[impact]?.[difficulty] : null;
		const configuredMin = Number(configured?.min);
		const configuredMax = Number(configured?.max);
		const min = Number.isFinite(configuredMin)
			? configuredMin
			: Number.isFinite(fallbackMin) ? fallbackMin : 0;
		const max = Number.isFinite(configuredMax)
			? configuredMax
			: Number.isFinite(fallbackMax) && fallbackMax > 0 ? fallbackMax : 100;
		const normalizedMin = Math.max(0, Math.min(100, min));
		const normalizedMax = Math.max(0, Math.min(100, max));
		return {
			min: normalizedMin,
			max: Math.max(normalizedMin, normalizedMax),
		};
	};

	const formatCprBand = (slot, crime, cprRequirements) => {
		const { min, max } = getSlotCprBand(slot, crime, cprRequirements);
		return max < 100 ? `${Math.round(min)}-${Math.round(max)}% CPR` : `${Math.round(min)}%+ CPR`;
	};

	const getMemberCprForSlot = (planner, memberId, crime, slot) => {
		const member = (planner?.members || []).find(
			(item) =>
				Number(item?.memberId || item?.playerId || item?.player_id || item?.id || 0) ===
				Number(memberId)
		);
		const crimes = member?.crimes || {};
		const crimeName = crime?.name || slot?.crimeName || slot?.recommended?.cprCrimeName || "";
		const roleName = slot?.role || slot?.recommended?.cprRoleName || slot?.position || "";
		const crimeEntry = Object.entries(crimes).find(
			([name]) => normalizeText(name) === normalizeText(crimeName)
		);
		if (!crimeEntry || !crimeEntry[1] || typeof crimeEntry[1] !== "object") return 0;
		const roleEntry = Object.entries(crimeEntry[1]).find(
			([name]) => normalizeText(name) === normalizeText(roleName)
		);
		const cpr = Number(roleEntry?.[1] || 0);
		return Number.isFinite(cpr) ? cpr : 0;
	};

	const memberFitsSlotBand = (cpr, slot, crime, cprRequirements) => {
		const { min, max } = getSlotCprBand(slot, crime, cprRequirements);
		return cpr > 0 && cpr >= min && cpr <= max;
	};

	const findFlexibleSlots = (planner, memberId, cprRequirements) => {
		const flexibleSlots = [];
		for (const crime of planner?.crimes || []) {
			for (const slot of crime.slots || []) {
				if (!slot?.recommended?.anyFree || slot.currentUserId || slot.currentUserName) continue;
				const cpr = getMemberCprForSlot(planner, memberId, crime, slot);
				if (!memberFitsSlotBand(cpr, slot, crime, cprRequirements)) continue;
				flexibleSlots.push({
					crimeId: crime.id || slot.crimeId,
					crimeName: crime.name || slot.crimeName || slot.recommended.cprCrimeName,
					difficulty: crime.difficulty,
					position: slot.position,
					role: slot.role || slot.recommended.cprRoleName,
					roleImpactLabel: slot.roleImpactLabel,
					cpr,
					cprBand: formatCprBand(slot, crime, cprRequirements),
					successChance: crime.recommendedSuccessChance,
				});
			}
		}

		return flexibleSlots.sort(
			(a, b) =>
				(a.difficulty || 0) - (b.difficulty || 0) ||
				String(a.crimeName || "").localeCompare(String(b.crimeName || "")) ||
				String(a.position || "").localeCompare(String(b.position || ""))
		);
	};

	const findCprEligibility = (planner, memberId, cprRequirements) => {
		const eligibleSlots = [];
		let ineligibleCount = 0;
		let missingCprCount = 0;
		let openSlotCount = 0;

		for (const crime of planner?.crimes || []) {
			const crimeStatus = String(crime.status || "").trim().toLowerCase();
			if (crimeStatus && crimeStatus !== "recruiting") continue;
			if (crime.openSlots !== undefined && Number(crime.openSlots) <= 0) continue;
			for (const slot of crime.slots || []) {
				if (slot.currentUserId || slot.currentUserName) continue;
				openSlotCount += 1;
				const cpr = getMemberCprForSlot(planner, memberId, crime, slot);
				if (!(cpr > 0)) {
					missingCprCount += 1;
					continue;
				}
				if (!memberFitsSlotBand(cpr, slot, crime, cprRequirements)) {
					ineligibleCount += 1;
					continue;
				}
				eligibleSlots.push({
					crimeId: crime.id || slot.crimeId,
					crimeName: crime.name || slot.crimeName,
					difficulty: crime.difficulty,
					position: slot.position,
					role: slot.role,
					roleImpactLabel: slot.roleImpactLabel,
					cpr,
					cprBand: formatCprBand(slot, crime, cprRequirements),
					successChance: crime.recommendedSuccessChance,
				});
			}
		}

		eligibleSlots.sort(
			(a, b) =>
				(a.difficulty || 0) - (b.difficulty || 0) ||
				String(a.crimeName || "").localeCompare(String(b.crimeName || "")) ||
				String(a.position || "").localeCompare(String(b.position || ""))
		);
		return { eligibleSlots, ineligibleCount, missingCprCount, openSlotCount };
	};

	const getProfileMemberIdentity = (profile) => {
		const memberId = Number(profile?.player_id || profile?.profile?.player_id || 0);
		const memberName =
			profile?.name ||
			profile?.player_name ||
			profile?.profile?.name ||
			profile?.profile?.player_name ||
			(memberId ? `Player ${memberId}` : "");
		return { memberId, memberName };
	};

	const getRecommendationPolicyStatus = (recommendationPolicy = {}) => ({
		runtimeStatus: String(recommendationPolicy.runtimeStatus || ""),
		runtimeMessage: String(recommendationPolicy.runtimeMessage || ""),
		runtimeError: String(recommendationPolicy.runtimeError || ""),
		snapshotSource: String(recommendationPolicy.snapshotSource || ""),
		snapshotGeneratedAt: recommendationPolicy.snapshotGeneratedAt || null,
		cprSnapshotStatus: String(recommendationPolicy.cprSnapshotStatus || ""),
		cprSnapshotGeneratedAt: recommendationPolicy.cprSnapshotGeneratedAt || null,
		cprSnapshotError: String(recommendationPolicy.cprSnapshotError || ""),
	});

	const buildMemberPayload = (profile, planner, recommendationPolicy = {}) => {
		const { memberId, memberName } = getProfileMemberIdentity(profile);
		const recommendationMode = recommendationPolicy.mode === "cpr" ? "cpr" : "plan";
		const cprRequirements = recommendationPolicy.cprRequirements || {};
		const recommendations = recommendationMode === "plan"
			? findSlotRecommendations(planner, memberId)
			: [];
		const planningSteps = recommendationMode === "plan" ? findPlanningSteps(planner, memberId) : [];
		const unassigned = recommendationMode === "plan" ? findUnassigned(planner, memberId) : [];
		const flexibleSlots = recommendationMode === "plan"
			? findFlexibleSlots(planner, memberId, cprRequirements)
			: [];
		const cprEligibility = recommendationMode === "cpr"
			? findCprEligibility(planner, memberId, cprRequirements)
			: { eligibleSlots: [], ineligibleCount: 0, missingCprCount: 0, openSlotCount: 0 };
		const missingCpr = (planner?.missingCprMembers || []).some(
			(member) => Number(member.memberId) === memberId
		);

		return {
			memberId,
			memberName,
			factionId: getPlannerFactionId(profile),
			noPlan: false,
			recommendationMode,
			...getRecommendationPolicyStatus(recommendationPolicy),
			plannerRunId: planner?.id,
			plannerGeneratedAt: planner?.generatedAt,
			summary: planner?.summary,
			recommendations,
			hasAssignedRole: recommendations.length > 0,
			planningSteps,
			unassigned,
			flexibleSlots,
			cprEligibleSlots: cprEligibility.eligibleSlots,
			cprIneligibleCount: cprEligibility.ineligibleCount,
			cprMissingCount: cprEligibility.missingCprCount,
			cprOpenSlotCount: cprEligibility.openSlotCount,
			missingCpr,
			warnings: planner?.warnings || [],
		};
	};

	const buildNoPlanPayload = (profile, noPlanReason, recommendationPolicy = {}) => ({
		...getProfileMemberIdentity(profile),
		factionId: getPlannerFactionId(profile),
		noPlan: true,
		noPlanReason: noPlanReason || "missing",
		recommendationMode: recommendationPolicy.mode === "cpr" ? "cpr" : "plan",
		...getRecommendationPolicyStatus(recommendationPolicy),
		plannerRunId: null,
		plannerGeneratedAt: null,
		summary: null,
		recommendations: [],
		hasAssignedRole: false,
		planningSteps: [],
		unassigned: [],
		flexibleSlots: [],
		cprEligibleSlots: [],
		cprIneligibleCount: 0,
		cprMissingCount: 0,
		cprOpenSlotCount: 0,
		missingCpr: false,
		warnings: [],
	});

	const syncInteractiveState = () => {
		const panel = document.getElementById(PANEL_ID);
		if (!panel) return;
		state.collapsed = panel.classList.contains("collapsed");
		state.disclosureOpen = !!panel.querySelector(".ocp-disclosure")?.open;
		state.flexibleOpen = !!panel.querySelector(".ocp-flexible")?.open;
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
			if (Date.now() < state.dragSuppressTapUntil) return;
			lastTouchAt = Date.now();
			event.preventDefault();
			handler(event);
		});
		element.addEventListener("click", (event) => {
			if (Date.now() < state.dragSuppressTapUntil) return;
			if (Date.now() - lastTouchAt < 500) return;
			handler(event);
		});
	};

	const attachPanelDragHandler = (panel) => {
		const header = panel?.querySelector(".ocp-header");
		if (!header) return;

		let drag = null;
		const stopDrag = (event) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			header.releasePointerCapture?.(event.pointerId);
			panel.classList.remove("ocp-dragging");
			if (drag.moved) {
				event.preventDefault();
				state.dragSuppressTapUntil = Date.now() + 700;
				const rect = panel.getBoundingClientRect();
				setPanelPosition(panel, { left: rect.left, top: rect.top }, true);
			}
			drag = null;
		};

		header.addEventListener("pointerdown", (event) => {
			if (event.button !== undefined && event.button !== 0) return;
			if (event.target?.closest?.(".ocp-actions, button, input, a, summary, details")) return;
			const rect = panel.getBoundingClientRect();
			drag = {
				pointerId: event.pointerId,
				startX: event.clientX,
				startY: event.clientY,
				left: rect.left,
				top: rect.top,
				moved: false,
			};
			header.setPointerCapture?.(event.pointerId);
		});

		header.addEventListener("pointermove", (event) => {
			if (!drag || event.pointerId !== drag.pointerId) return;
			const dx = event.clientX - drag.startX;
			const dy = event.clientY - drag.startY;
			if (!drag.moved && Math.hypot(dx, dy) < 6) return;
			drag.moved = true;
			state.dragSuppressTapUntil = Date.now() + 700;
			panel.classList.add("ocp-dragging");
			event.preventDefault();
			setPanelPosition(panel, { left: drag.left + dx, top: drag.top + dy });
		});

		header.addEventListener("pointerup", stopDrag);
		header.addEventListener("pointercancel", stopDrag);
	};

	const collapsePanelWithoutRender = () => {
		state.collapsed = true;
		const panel = document.getElementById(PANEL_ID);
		panel?.classList.add("collapsed");
		const title = panel?.querySelector(".ocp-title");
		if (title) {
			const memberName = state.lastPayload?.memberName || state.profile?.name || "Askelads OC";
			const compactTitle = `${memberName} - ${compactPanelSummary(state.lastPayload)}`;
			title.textContent = compactTitle;
			title.title = compactTitle;
		}
		const collapseButton = panel?.querySelector(".ocp-collapse");
		if (collapseButton) {
			collapseButton.textContent = "+";
			collapseButton.title = "Expand";
		}
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
		state.lastAttemptAt = Date.now();
		state.loading = true;
		state.error = "";
		state.progress = "Loading your Torn profile...";
		render();

		try {
			const previousFactionId = getPlannerFactionId(state.profile);
			let profile = force ? null : getCachedProfile(key);
			if (!profile) {
				state.progress = "Validating API key with Torn...";
				render();
				profile = await getProfileWithKey(key);
				saveCachedProfile(key, profile);
			}
			const currentFactionId = getPlannerFactionId(profile);
			if (!currentFactionId) {
				throw new Error("Your Torn profile does not currently show a faction.");
			}
			state.profile = profile;
			if (previousFactionId && previousFactionId !== currentFactionId) {
				stopHighlightLock();
				clearRecommendationJoinCues();
				clearRecommendationHighlights();
				clearCachedMemberPayload();
				state.lastPlanner = null;
				state.lastPayload = null;
				state.snapshotRevision = "";
				state.lastHighlightRecommendation = null;
				state.targetFeedback = null;
				state.takenRecommendationKeys.clear();
			}
			if (!state.lastPayload) hydrateCachedMemberPayload(key, profile);

			state.progress = "Loading latest OC planner snapshot...";
			render();

			const snapshot = await getLatestPlanner(
				currentFactionId,
				state.lastPayload ? state.snapshotRevision : "",
				force
			);
			const checkedAt = Math.floor(Date.now() / 1000);
			state.snapshotRevision = snapshot.revision;
			if (snapshot.unchanged && state.lastPayload) {
				state.lastCheckedAt = checkedAt;
				state.usingCachedPayload = false;
				state.progress = "";
				state.error = "";
				saveCachedMemberPayload(
					key,
					state.profile,
					state.lastPayload,
					checkedAt,
					state.snapshotRevision
				);
				if (snapshot.status !== "unavailable") {
					void recordScriptAccessIfNeeded(state.profile, {
						id: state.lastPayload.plannerRunId,
						generatedAt: state.lastPayload.plannerGeneratedAt,
					});
				}
				return;
			}
			const planner = snapshot.recommendationPolicy.plannerRefreshRequired
				? null
				: snapshot.planner;
			state.lastPlanner = planner;
			const nextPayload = planner
				? buildMemberPayload(state.profile, planner, snapshot.recommendationPolicy)
				: buildNoPlanPayload(state.profile, snapshot.status, snapshot.recommendationPolicy);
			const nextRecommendationKeys = new Set(
				nextPayload.recommendations.map(getRecommendationKey)
			);
			if (planner) {
				state.takenRecommendationKeys = new Set(
					[...state.takenRecommendationKeys].filter((key) => nextRecommendationKeys.has(key))
				);
			} else {
				stopHighlightLock();
				clearRecommendationJoinCues();
				state.lastHighlightRecommendation = null;
				state.targetFeedback = null;
				state.takenRecommendationKeys.clear();
			}
			state.lastPayload = nextPayload;
			state.lastCheckedAt = checkedAt;
			state.usingCachedPayload = false;
			if (!state.takenRecommendationKeys.size && state.targetFeedback?.kind === "filled") {
				state.targetFeedback = null;
			}
			saveCachedMemberPayload(
				key,
				state.profile,
				state.lastPayload,
				checkedAt,
				state.snapshotRevision
			);
			state.progress = "";
			state.error = "";
			clearRecommendationHighlights();
			if (snapshot.status !== "unavailable") {
				void recordScriptAccessIfNeeded(state.profile, planner);
			}
		} catch (error) {
			state.error = getFriendlyErrorMessage(error);
			state.progress = "";
		} finally {
			state.loading = false;
			render();
			scheduleAutoRefresh();
		}
	};

	const getNextRefreshDelay = () => {
		if (state.error) return ACTIVE_REFRESH_MS;
		const payload = state.lastPayload;
		if (
			payload?.noPlanReason === "refreshing" ||
			payload?.runtimeStatus === "plan_generating" ||
			payload?.cprSnapshotStatus === "refreshing"
		) {
			return ACTIVE_REFRESH_MS;
		}
		return AUTO_REFRESH_MS;
	};

	const scheduleAutoRefresh = (delay = getNextRefreshDelay()) => {
		if (state.autoRefreshTimer) window.clearTimeout(state.autoRefreshTimer);
		state.autoRefreshTimer = window.setTimeout(() => {
			if (document.visibilityState === "hidden") {
				scheduleAutoRefresh(delay);
				return;
			}
			if (state.active && isOcCrimesPage() && getStoredKey()) {
				refreshRecommendations(false);
			}
		}, delay);
	};
	const isRefreshDue = () => {
		const lastActivityAt = Math.max(state.lastAttemptAt, state.lastCheckedAt * 1000);
		return !lastActivityAt || Date.now() - lastActivityAt >= getNextRefreshDelay();
	};
	const getRefreshRemainingDelay = () => {
		const lastActivityAt = Math.max(state.lastAttemptAt, state.lastCheckedAt * 1000);
		if (!lastActivityAt) return 0;
		return Math.max(1000, getNextRefreshDelay() - (Date.now() - lastActivityAt));
	};

	const resumeVisibleRefresh = () => {
		if (document.visibilityState !== "visible") return;
		if (
			state.active &&
			isOcCrimesPage() &&
			getStoredKey() &&
			!state.loading &&
			isRefreshDue()
		) {
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

	const compactCrimeLabel = (name, id) => {
		const crimeName = name || "Organized crime";
		return id ? `${crimeName} #${id}` : crimeName;
	};

	const currentOcLabel = (recommendation) => {
		if (recommendation.currentCrimeName) {
			const current = compactCrimeLabel(
				recommendation.currentCrimeName,
				recommendation.currentCrimeId
			);
			return recommendation.availableAt
				? `${current} - free ${formatTimestamp(recommendation.availableAt)}`
				: current;
		}
		if (recommendation.availableAt && recommendation.availableAt > Math.floor(Date.now() / 1000)) {
			return `Free ${formatTimestamp(recommendation.availableAt)}`;
		}
		return "Free now";
	};

	const currentStepTitle = (recommendation) => {
		if (recommendation?.currentCrimeName) return "Finish current OC";
		if (recommendation?.availableAt && recommendation.availableAt > Math.floor(Date.now() / 1000)) {
			return "Wait until free";
		}
		return "Ready now";
	};

	const currentStepCard = (recommendation) => {
		if (!recommendation) return "";
		return `
			<div class="ocp-plan-box current ocp-compact-line" title="${escapeHtml(currentOcLabel(recommendation))}">
				<span class="ocp-line-label">Current</span>
				<span class="ocp-line-value">${escapeHtml(currentStepTitle(recommendation))} - ${escapeHtml(currentOcLabel(recommendation))}</span>
			</div>
		`;
	};

	const recommendationCard = (recommendation, index) => {
		const crimeUrl = getCrimeUrl(recommendation.crimeId);
		const timelineLabel = index === 0 ? "Next" : "Then";
		const startLabel =
			recommendation.plannedStartAt && recommendation.plannedStartAt > Math.floor(Date.now() / 1000)
				? `${formatRelative(recommendation.plannedStartAt)} (${formatTimestamp(recommendation.plannedStartAt)})`
				: "now";
		const plannedFinishAt = recommendation.plannedOcCompleteAt || recommendation.plannedMemberEndAt;
		const finishLabel = plannedFinishAt
			? `${formatRelative(plannedFinishAt)} (${formatTimestamp(plannedFinishAt)})`
			: "";
		const successChance = formatChance(recommendation.successChance);
		const team = recommendation.expectedTeam || [];
		const getTeamState = (member) =>
			member.isCurrent ? "Joined" : member.isForced ? "Forced" : member.isOpen ? "Open" : "Planned";
		const lineupCounts = team.reduce(
			(counts, member) => {
				counts[getTeamState(member).toLowerCase()] += 1;
				return counts;
			},
			{ joined: 0, planned: 0, forced: 0, open: 0 }
		);
		const lineupSummary = [
			lineupCounts.joined ? `${lineupCounts.joined} joined` : "",
			lineupCounts.planned ? `${lineupCounts.planned} planned` : "",
			lineupCounts.forced ? `${lineupCounts.forced} forced` : "",
			lineupCounts.open ? `${lineupCounts.open} open` : "",
		]
			.filter(Boolean)
			.join(" <span aria-hidden=\"true\">&middot;</span> ");
		const expectedTeam = team
			.map(
				(member) => {
					const teamState = getTeamState(member);
					const stateClass = teamState.toLowerCase();
					return `
					<span class="ocp-team-chip ${member.isYou ? "you" : ""} ${member.isCurrent ? "current" : ""} ${member.isForced ? "forced" : ""} ${member.isOpen ? "open" : ""}">
						<span class="ocp-chip-slot">${escapeHtml(member.slot)}:</span>
						<span class="ocp-chip-member">${escapeHtml(member.memberName)}</span>
						<span class="ocp-chip-flags">
							<span class="ocp-chip-flag ${stateClass}">${teamState}</span>
							${member.isForced && teamState !== "Forced" ? `<span class="ocp-chip-flag forced">Forced</span>` : ""}
						</span>
					</span>
				`;
				}
			)
			.join("");
		const nextMeta = [recommendation.difficulty ? `T${recommendation.difficulty}` : ""]
			.filter(Boolean)
			.join("");
		const miniMeta = [
			`Start ${startLabel}`,
			finishLabel ? `Finish ${finishLabel}` : "",
			recommendation.cpr ? `${Math.round(Number(recommendation.cpr || 0))}% CPR` : "",
			successChance ? `${successChance} success` : "",
		]
			.filter(Boolean)
			.map((item) => `<span>${escapeHtml(item)}</span>`)
			.join("");

		return `
			<div class="ocp-card plan next">
				<a class="ocp-plan-box next ocp-card-link" href="${escapeHtml(crimeUrl)}" data-ocp-crime-id="${escapeHtml(recommendation.crimeId)}" data-ocp-crime-name="${escapeHtml(recommendation.crimeName || "")}" data-ocp-role="${escapeHtml(recommendation.role || "")}" data-ocp-position="${escapeHtml(recommendation.position || "")}" data-ocp-role-impact="${escapeHtml(recommendation.roleImpactLabel || "")}">
					<span class="ocp-next-head">
						<span class="ocp-next-main"><strong>${timelineLabel}:</strong> Join ${escapeHtml(compactCrimeLabel(recommendation.crimeName, recommendation.crimeId))} / ${escapeHtml(recommendation.position || recommendation.role || "Slot")}</span>
						${nextMeta ? `<span class="ocp-next-meta">${escapeHtml(nextMeta)}</span>` : ""}
					</span>
					${miniMeta ? `<span class="ocp-mini-meta">${miniMeta}</span>` : ""}
					${expectedTeam ? `<span class="ocp-team"><span class="ocp-team-title"><span>Lineup</span><span class="ocp-team-summary">${lineupSummary}</span></span><span class="ocp-team-chips">${expectedTeam}</span></span>` : ""}
				</a>
			</div>
		`;
	};

	const flexibleSlotCard = (slot, cprMode = false) => {
		const crimeUrl = getCrimeUrl(slot.crimeId);
		const successChance = formatChance(slot.successChance);
		const linkLabel = cprMode ? "Find eligible role" : `View role in OC #${slot.crimeId}`;
		const meta = [
			slot.difficulty ? `T${slot.difficulty}` : "",
			slot.cpr ? `${Math.round(Number(slot.cpr || 0))}% CPR` : "",
			slot.cprBand ? `needs ${slot.cprBand}` : "",
			successChance ? `${successChance} success` : "",
		]
			.filter(Boolean)
			.map((item) => `<span>${escapeHtml(item)}</span>`)
			.join("");

		return `
			<div class="ocp-flexible-item">
				<div class="ocp-card-heading">
					<span>${escapeHtml(compactCrimeLabel(slot.crimeName, slot.crimeId))}</span>
					<span class="ocp-muted">${escapeHtml(slot.position || slot.role || "Slot")}</span>
					${cprMode ? `<span class="ocp-pill">CPR eligible</span>` : ""}
				</div>
				${meta ? `<div class="ocp-mini-meta">${meta}</div>` : ""}
				<a class="ocp-card-link" href="${escapeHtml(crimeUrl)}" data-ocp-crime-id="${escapeHtml(slot.crimeId)}" data-ocp-crime-name="${escapeHtml(slot.crimeName || "")}" data-ocp-role="${escapeHtml(slot.role || "")}" data-ocp-position="${escapeHtml(slot.position || "")}" data-ocp-role-impact="${escapeHtml(slot.roleImpactLabel || "")}">${escapeHtml(linkLabel)}</a>
			</div>
		`;
	};

	const cprEligibleCrimeCard = (slots) => {
		const crime = slots[0];
		if (!crime) return "";
		const crimeUrl = getCrimeUrl(crime.crimeId);
		const successChance = formatChance(crime.successChance);
		const roleChips = slots
			.map((slot) => {
				const role = slot.position || slot.role || "Slot";
				const cpr = slot.cpr ? `${Math.round(Number(slot.cpr || 0))}%` : "CPR ?";
				const requirement = slot.cprBand ? `Needs ${slot.cprBand}` : "Within limits";
				return `<span class="ocp-cpr-role-chip" title="${escapeHtml(`${role}: ${cpr}. ${requirement}`)}"><span>${escapeHtml(role)}</span><strong>${escapeHtml(cpr)}</strong>${slot.cprBand ? `<span class="ocp-cpr-role-requirement">needs ${escapeHtml(slot.cprBand)}</span>` : ""}</span>`;
			})
			.join("");
		const meta = [
			crime.difficulty ? `T${crime.difficulty}` : "",
			successChance ? `${successChance} success` : "",
		]
			.filter(Boolean)
			.join(" | ");

		return `
			<div class="ocp-flexible-item">
				<a class="ocp-card-link ocp-cpr-crime-link" href="${escapeHtml(crimeUrl)}" data-ocp-target-kind="cpr-crime" data-ocp-crime-id="${escapeHtml(crime.crimeId)}" data-ocp-crime-name="${escapeHtml(crime.crimeName || "")}">
					<span class="ocp-cpr-crime-head">
						<strong class="ocp-cpr-crime-name">${escapeHtml(compactCrimeLabel(crime.crimeName, crime.crimeId))}</strong>
						<span class="ocp-pill">${slots.length} role${slots.length === 1 ? "" : "s"}</span>
					</span>
					<span class="ocp-cpr-role-row" aria-label="Eligible roles">${roleChips}</span>
					<span class="ocp-cpr-link-meta"><span>${escapeHtml(meta)}</span><span>Find role${slots.length === 1 ? "" : "s"}</span></span>
				</a>
			</div>
		`;
	};

	const unassignedCard = (member) => `
		<div class="ocp-card need-more">
			<div class="ocp-card-title">No assignment</div>
			<div class="ocp-grid">
				${member.bestCprCrimeName ? `<div class="ocp-label">Best fit</div><div class="ocp-value">${escapeHtml(member.bestCprCrimeName)}</div>` : ""}
				${member.bestCprRoleName ? `<div class="ocp-label">Role</div><div class="ocp-value">${escapeHtml(member.bestCprRoleName)}</div>` : ""}
				${member.bestCpr ? `<div class="ocp-label">CPR</div><div class="ocp-value">${escapeHtml(Math.round(Number(member.bestCpr)))}%</div>` : ""}
				${member.availableAt ? `<div class="ocp-label">Available</div><div class="ocp-value">${escapeHtml(formatRelative(member.availableAt))}</div>` : ""}
			</div>
		</div>
	`;

	const renderCprSnapshotStatus = (payload) => {
		const snapshotAge = formatAge(payload.cprSnapshotGeneratedAt || payload.snapshotGeneratedAt);
		if (payload.snapshotSource === "plan_fallback") {
			return '<div class="ocp-flexible-note ocp-muted">Refreshing CPR; showing saved data.</div>';
		}
		if (payload.cprSnapshotStatus === "failed") {
			return `<div class="ocp-flexible-note ocp-muted">CPR refresh failed.${snapshotAge ? ` Data ${escapeHtml(snapshotAge)}.` : ""}</div>`;
		}
		if (payload.cprSnapshotStatus === "refreshing") {
			return `<div class="ocp-flexible-note ocp-muted">Refreshing CPR.${snapshotAge ? ` Data ${escapeHtml(snapshotAge)}.` : ""}</div>`;
		}
		return "";
	};

	const renderCprEligibilityResults = (payload) => {
		const eligibleSlots = (payload.cprEligibleSlots || []).filter(
			(slot) => !state.takenRecommendationKeys.has(getRecommendationKey(slot))
		);
		const eligibleCrimeGroups = groupCprSlotsByCrime(eligibleSlots);
		const eligibleItems = eligibleCrimeGroups.map(cprEligibleCrimeCard).join("");
		const unavailableCount = Number(payload.cprIneligibleCount || 0);
		const missingCount = Number(payload.cprMissingCount || 0);
		const exclusionSummary = [
			unavailableCount ? `${unavailableCount} outside your CPR limits` : "",
			missingCount ? `${missingCount} missing role CPR` : "",
		]
			.filter(Boolean)
			.join(" | ");
		const snapshotStatus = renderCprSnapshotStatus(payload);
		const roleCount = eligibleSlots.length;
		const crimeCount = eligibleCrimeGroups.length;
		const rule = roleCount
			? "Green roles are allowed."
			: "No allowed roles.";

		return `
			<div class="ocp-cpr-overview">
				<div class="ocp-cpr-summary">
					<span class="ocp-cpr-mode">CPR</span>
					<span class="ocp-cpr-counts"><strong>${roleCount} allowed</strong><span>${crimeCount} OC${crimeCount === 1 ? "" : "s"}</span></span>
				</div>
				<div class="ocp-cpr-rule"><span class="ocp-cpr-swatch" aria-hidden="true"></span><span>${escapeHtml(rule)}</span></div>
				${snapshotStatus ? `<div class="ocp-cpr-warning">${snapshotStatus}</div>` : ""}
			</div>
			${eligibleItems ? `<details class="ocp-flexible ocp-cpr-details"${state.flexibleOpen ? " open" : ""}>
				<summary>Allowed roles (${roleCount})</summary>
				<div class="ocp-flexible-body">
					${exclusionSummary ? `<div class="ocp-flexible-note ocp-muted">${escapeHtml(exclusionSummary)}</div>` : ""}
					${eligibleItems}
				</div>
			</details>` : ""}
		`;
	};

	const getNoPlanCopy = (payload) => {
		if (payload.noPlanReason === "unavailable") {
			return {
				title: "Planner unavailable",
				message: "Disabled for this faction.",
			};
		}
		if (payload.recommendationMode === "cpr" && payload.cprSnapshotStatus === "refreshing") {
			return {
				title: "Loading CPR",
				message: "Waiting for the first snapshot.",
			};
		}
		if (payload.recommendationMode === "cpr" && payload.cprSnapshotStatus === "failed") {
			return {
				title: "CPR unavailable",
				message: "Refresh failed; retrying.",
			};
		}
		if (payload.noPlanReason === "failed" || payload.runtimeStatus === "plan_failed") {
			return {
				title: "Plan failed",
				message: "Admin refresh required.",
			};
		}
		if (payload.noPlanReason === "stale" || payload.runtimeStatus === "plan_stale") {
			return {
				title: "Plan outdated",
				message: "Admin refresh required.",
			};
		}
		if (payload.noPlanReason === "refreshing") {
			return {
				title: "Plan refreshing",
				message: "Assignments hidden until ready.",
			};
		}
		return {
			title: "No faction plan",
			message: payload.recommendationMode === "cpr" ? "CPR snapshot required." : "Admin setup required.",
		};
	};

	const renderResults = () => {
		const payload = state.lastPayload;
		if (!payload) return "";
		if (payload.noPlan) {
			const copy = getNoPlanCopy(payload);
			return `
				<div class="ocp-card no-plan">
					<div class="ocp-card-title">${copy.title}</div>
					<div>${copy.message}</div>
				</div>
			`;
		}
		if (payload.recommendationMode === "cpr") {
			return renderCprEligibilityResults(payload);
		}

		const cards = payload.recommendations.map(recommendationCard).join("");
		const current = payload.recommendations.length ? currentStepCard(payload.recommendations[0]) : "";
		const mayUseFlexibleSlots = !payload.recommendations.length || state.takenRecommendationKeys.size > 0;
		const flexibleSlots = mayUseFlexibleSlots
			? (payload.flexibleSlots || []).filter(
					(slot) => !state.takenRecommendationKeys.has(getRecommendationKey(slot))
				)
			: [];
		const flexibleItems = flexibleSlots.map(flexibleSlotCard).join("");
		const flexible = flexibleItems
			? `<details class="ocp-flexible"${state.flexibleOpen ? " open" : ""}>
				<summary>Other suitable openings (${flexibleSlots.length})</summary>
				<div class="ocp-flexible-body">
					<div class="ocp-flexible-note ocp-muted">Not reserved; CPR within range.</div>
					${flexibleItems}
				</div>
			</details>`
			: "";
		const unassigned = !payload.recommendations.length
			? payload.unassigned.map(unassignedCard).join("")
			: "";
		const missingCpr = payload.missingCpr
			? `<div class="ocp-card need-more"><div class="ocp-card-title">Missing CPR</div><div>No CPR data found.</div></div>`
			: "";
		const empty = !cards && !flexible && !unassigned && !missingCpr
			? `<div class="ocp-card"><div class="ocp-card-title">No assignment</div></div>`
			: "";

		return `
			${current}
			${cards}
			${unassigned}
			${flexible}
			${missingCpr}
			${empty}
		`;
	};

	const plannerStatusText = () => {
		if (state.progress) {
			return state.usingCachedPayload && state.lastPayload
				? "Checking update | Cached result shown"
				: state.progress;
		}
		const payload = state.lastPayload;
		const checkedAge = formatAge(state.lastCheckedAt);
		const cprMode = payload?.recommendationMode === "cpr";
		const modeSuffix = cprMode ? " | CPR" : "";
		if (payload?.noPlan) {
			const availability = payload.noPlanReason === "unavailable"
				? "Planner unavailable"
				: payload.noPlanReason === "failed"
					? "Generation failed"
					: payload.noPlanReason === "stale" ? "Fresh plan needed" : "No faction plan";
			const source = state.usingCachedPayload ? "Cached" : "Checked";
			return checkedAge ? `${source} ${checkedAge} | ${availability}${modeSuffix}` : `${availability}${modeSuffix}`;
		}
		if (!payload?.plannerGeneratedAt) return state.loading ? "Loading..." : "";
		const planAge = formatAge(payload.plannerGeneratedAt);
		const dataLabel = cprMode ? "OC data" : "Plan";
		if (state.usingCachedPayload) {
			return checkedAge ? `Cached ${checkedAge} | ${dataLabel} ${planAge || "saved"}${modeSuffix}` : `Cached | ${dataLabel} ${planAge || "saved"}${modeSuffix}`;
		}
		return checkedAge ? `Checked ${checkedAge} | ${dataLabel} ${planAge || "saved"}${modeSuffix}` : `${dataLabel} ${planAge || "saved"}${modeSuffix}`;
	};

	const compactPanelSummary = (payload) => {
		if (state.loading && !payload) return "Checking";
		if (state.error && !payload) return "Connection issue";
		if (payload?.noPlan) {
			if (payload.noPlanReason === "refreshing") return "Plan refreshing";
			if (payload.noPlanReason === "failed") return "Plan failed";
			if (payload.noPlanReason === "unavailable") return "Unavailable";
			return "No plan";
		}
		if (payload?.recommendationMode === "cpr") {
			const count = Number(payload.cprEligibleSlots?.length || 0);
			return `${count} CPR role${count === 1 ? "" : "s"}`;
		}
		const next = payload?.recommendations?.[0];
		if (next) {
			const step = Number(next.planningStep || 0);
			const role = next.position || next.role || "Next OC";
			return `${step ? `Step ${step}: ` : ""}${role}`;
		}
		const flexibleCount = Number(payload?.flexibleSlots?.length || 0);
		if (flexibleCount) return `${flexibleCount} suitable opening${flexibleCount === 1 ? "" : "s"}`;
		if (payload?.missingCpr) return "Missing CPR";
		return payload ? "No assignment" : "OC Planner";
	};

	const panelStateTone = () => {
		if (state.error) return "error";
		if (state.loading) return "loading";
		if (state.lastPayload && !state.lastPayload.noPlan) return "ready";
		return "idle";
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
		const memberName =
			state.lastPayload?.memberName ||
			state.profile?.name ||
			"Askelads OC";
		const headerName = collapsed
			? `${memberName} - ${compactPanelSummary(state.lastPayload)}`
			: memberName;
		const statusText = plannerStatusText();
		const stateTone = panelStateTone();
		const feedback = state.targetFeedback;
		const lastHighlightRoleCount = getHighlightRecommendations(state.lastHighlightRecommendation).length;
		const highlightAgain = `<button class="ocp-button ocp-highlight-again" title="Highlight again"${!state.lastHighlightRecommendation || state.pendingHighlight ? " hidden" : ""}>${lastHighlightRoleCount > 1 ? "Find roles" : "Find role"}</button>`;
		const keyControls = savedKey
			? `
				<div class="ocp-row ocp-toolbar">
					<button class="ocp-button primary ocp-save-refresh">${state.loading ? "Loading" : "Refresh"}</button>
					<span class="ocp-toolbar-status" title="${escapeHtml(statusText)}">${escapeHtml(statusText)}</span>
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
				<div class="ocp-title-group">
					<div class="ocp-title-line">
						<span class="ocp-state-dot ${escapeHtml(stateTone)}" title="${escapeHtml(statusText || compactPanelSummary(state.lastPayload))}"></span>
						<div class="ocp-title" title="${escapeHtml(headerName)}">${escapeHtml(headerName)}</div>
						<span class="ocp-version">v${escapeHtml(SCRIPT_VERSION)}</span>
					</div>
					<span class="ocp-target-feedback ${escapeHtml(feedback?.kind || "")}" aria-live="polite" title="${escapeHtml(feedback?.detail || feedback?.label || "")}"${feedback ? "" : " hidden"}>${escapeHtml(feedback?.label || "")}</span>
				</div>
				<div class="ocp-actions">
					${highlightAgain}
					<button class="ocp-button ocp-highlight-stop" title="Stop highlight"${state.pendingHighlight ? "" : " hidden"}>Stop</button>
					<button class="ocp-icon-button ocp-collapse" title="${collapsed ? "Expand" : "Collapse"}">${collapsed ? "+" : "-"}</button>
				</div>
			</div>
			<div class="ocp-body">
				${backendConfigured ? "" : `<div class="ocp-error">Set BACKEND_BASE_URL in the userscript before using it.</div>`}
				${keyControls}
				${!savedKey && state.progress ? `<div class="ocp-status">${escapeHtml(state.progress)}</div>` : ""}
				${state.error ? `<div class="ocp-error">${escapeHtml(state.error)}</div>` : ""}
				${renderResults()}
				<details class="ocp-disclosure"${state.disclosureOpen ? " open" : ""}>
					<summary>${savedKey ? "Privacy" : "API key use"}</summary>
					<table>
						<tr><th>Local</th><td>API key and cached recommendation.</td></tr>
						<tr><th>Key</th><td>Sent only to Torn for profile lookup.</td></tr>
						<tr><th>Backend</th><td>Planner data and script check-in; never your key.</td></tr>
						<tr><th>Actions</th><td>Display only. No joins or submissions.</td></tr>
					</table>
					${savedKey ? `<div class="ocp-privacy-actions"><button class="ocp-button danger ocp-forget">Change key</button></div>` : ""}
				</details>
			</div>
		`;

		if (markup === lastRenderedMarkup) {
			syncTargetFeedbackElement();
			syncHighlightControls();
			syncRecommendationJoinCues();
			syncCprEligibilityHighlights();
			return;
		}
		panel.innerHTML = markup;
		lastRenderedMarkup = markup;
		panel.classList.toggle("collapsed", state.collapsed);
		applyStoredPanelPosition();
		attachPanelDragHandler(panel);

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
		addTapHandler(panel.querySelector(".ocp-highlight-stop"), (event) => {
			event.stopPropagation();
			stopHighlightLock();
			setTargetFeedback("", "");
		});
		panel.querySelector(".ocp-disclosure")?.addEventListener("toggle", (event) => {
			state.disclosureOpen = !!event.currentTarget.open;
		});
		panel.querySelector(".ocp-flexible")?.addEventListener("toggle", (event) => {
			state.flexibleOpen = !!event.currentTarget.open;
		});
		panel.querySelectorAll(".ocp-card-link").forEach((link) => {
			const getLinkRecommendation = () => {
				const crimeId = String(link.dataset.ocpCrimeId || "");
				if (link.dataset.ocpTargetKind === "cpr-crime") {
					const eligibleRoles = (state.lastPayload?.cprEligibleSlots || []).filter(
						(slot) =>
							String(slot.crimeId || "") === crimeId &&
							!state.takenRecommendationKeys.has(getRecommendationKey(slot))
					);
					return {
						crimeId,
						crimeName: link.dataset.ocpCrimeName,
						eligibleRoles,
					};
				}
				return {
					crimeId,
					crimeName: link.dataset.ocpCrimeName,
					role: link.dataset.ocpRole,
					position: link.dataset.ocpPosition,
					roleImpactLabel: link.dataset.ocpRoleImpact,
				};
			};
			const prepareOcNavigation = () => {
				queueHighlightRecommendation(getLinkRecommendation());
			};
			const collapseAfterNavigationTap = () => {
				window.setTimeout(() => collapsePanelWithoutRender(), 50);
			};
			link.addEventListener("pointerdown", prepareOcNavigation);
			link.addEventListener("touchend", collapseAfterNavigationTap);
			link.addEventListener("click", () => {
				prepareOcNavigation();
				collapseAfterNavigationTap();
			});
		});
		syncTargetFeedbackElement();
		syncHighlightControls();
		panel.querySelector(".ocp-save-refresh")?.addEventListener("click", () => refreshRecommendations(true));
		panel.querySelector(".ocp-forget")?.addEventListener("click", () => {
			stopHighlightLock();
			storage.remove(STORAGE_KEY);
			storage.remove(PROFILE_STORAGE_KEY);
			clearCachedMemberPayload();
			state.profile = null;
			state.lastPlanner = null;
			state.lastPayload = null;
			state.takenRecommendationKeys.clear();
			state.targetFeedback = null;
			state.error = "Paste a new Torn API key.";
			state.progress = "";
			state.disclosureOpen = false;
			state.flexibleOpen = false;
			render();
		});
		panel.querySelector(".ocp-api-key")?.addEventListener("keydown", (event) => {
			if (event.key === "Enter") refreshRecommendations(true);
		});
		window.setTimeout(() => {
			syncRecommendationJoinCues();
			syncCprEligibilityHighlights();
		}, 0);
	};

	const start = () => {
		const key = getStoredKey();
		if (key) {
			state.profile = getCachedProfile(key);
			if (state.profile) hydrateCachedMemberPayload(key, state.profile);
		}
		state.active = isOcCrimesPage();
		render();
		if (state.active && key && !/YOUR_BACKEND_HOST/i.test(getBackendBaseUrl())) {
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
		if (
			getStoredKey() &&
			!/YOUR_BACKEND_HOST/i.test(getBackendBaseUrl()) &&
			isRefreshDue()
		) {
			refreshRecommendations(false);
		} else if (getStoredKey()) {
			scheduleAutoRefresh(getRefreshRemainingDelay());
		}
	};

	const nodeTouchesOcDom = (node) => {
		const element = node instanceof Element ? node : node?.parentElement;
		if (!element || isInsidePanel(element)) return false;
		const selector =
			`a[href*='crimeId'], [data-crime-id], [data-crimeid], [data-oc-id], [class*='slot'], [class*='Slot'], [class*='crime'], [class*='Crime'], h1, h2, h3, h4, h5, h6, .${JOIN_CUE_BADGE_CLASS}`;
		return element.matches?.(selector) || !!element.querySelector?.(selector);
	};

	const queuePageDomSync = (delay = 250) => {
		if (state.domSyncTimer) return;
		state.domSyncTimer = window.setTimeout(() => {
			state.domSyncTimer = undefined;
			syncPageActivation();
			if (state.active) {
				syncRecommendationJoinCues();
				syncCprEligibilityHighlights();
			}
		}, delay);
	};

	const startPageObserver = () => {
		if (state.pageObserver || typeof MutationObserver !== "function" || !document.body) return;
		state.pageObserver = new MutationObserver((mutations) => {
			const relevant = mutations.some((mutation) =>
				[...mutation.addedNodes, ...mutation.removedNodes].some(nodeTouchesOcDom)
			);
			if (relevant) queuePageDomSync();
		});
		state.pageObserver.observe(document.body, { childList: true, subtree: true });
	};

	window.addEventListener("hashchange", () => {
		syncPageActivation();
		queuePageDomSync(100);
		window.setTimeout(() => retryPendingHighlight(), 600);
		window.setTimeout(() => retryPendingHighlight(), 1600);
	});
	window.addEventListener("popstate", () => {
		syncPageActivation();
		queuePageDomSync(100);
		window.setTimeout(() => retryPendingHighlight(), 600);
		window.setTimeout(() => retryPendingHighlight(), 1600);
	});
	document.addEventListener("visibilitychange", resumeVisibleRefresh);
	window.addEventListener("resize", applyStoredPanelPosition);

	if (document.readyState === "loading") {
		document.addEventListener("DOMContentLoaded", () => {
			startPageObserver();
			start();
		}, { once: true });
	} else {
		startPageObserver();
		start();
	}
})();
