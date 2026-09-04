/**
 * dsh-session-pins (client half) — two registrations sharing one RPC-backed
 * pin store (this bundle's factory scope):
 *
 *  1. `conversation.session.header.actions`: a pin toggle for the current
 *     session (📌). Title is resolved from the live session list snapshot at
 *     pin time (`sessions.list` — displayTitle, the same label the sidebar
 *     shows).
 *  2. `sidebar.footer.action`: a "置顶会话" row opening an upward popover of
 *     pinned sessions; clicking a row navigates via `sessions.open(id)`, the
 *     ✕ unpins. Entries no longer in the session list render dimmed but stay
 *     (they may be archived, not deleted).
 *
 * State lives host-side (see lib/index.js), so pins survive restarts and the
 * per-launch random port that silently resets the stock browser-local order.
 *
 * Plain script in the `window.__ModuleLoader__` bundle format: no JSX, no
 * imports — module ids resolve through the web shell's static module table.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-pins",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var h = React.createElement;
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useRef = React.useRef;
		var useSyncExternalStore = React.useSyncExternalStore;

		//#region i18n
		var NS = "session-pins";
		var zh = {
			"toggle.pin": "置顶此会话",
			"toggle.unpin": "取消置顶",
			"panel.label": "置顶会话",
			"panel.empty": "还没有置顶会话。点击会话标题栏的 📌 置顶常用会话。",
			"panel.error": "读取置顶失败：{message}",
			"panel.missing": "（已不在会话列表）",
		};
		var en = {
			"toggle.pin": "Pin this session",
			"toggle.unpin": "Unpin",
			"panel.label": "Pinned sessions",
			"panel.empty": "No pinned sessions yet. Use the 📌 in a session header to pin it.",
			"panel.error": "Failed to load pins: {message}",
			"panel.missing": "(no longer listed)",
		};
		function tx(t, key, params) {
			var out = t(key);
			if (out === key) out = en[key] || key;
			if (params) for (var k in params) out = out.replace("{" + k + "}", String(params[k]));
			return out;
		}
		//#endregion

		//#region styles
		var CSS = ""
			+ ".dsh-pins_toggle{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border:none;border-radius:8px;background:0 0;cursor:pointer;font-size:14px;line-height:1;color:var(--dsw-alias-label-tertiary);transition:background .15s ease,color .15s ease;font-family:inherit}"
			+ ".dsh-pins_toggle:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}"
			+ ".dsh-pins_toggle[data-pinned=true]{color:var(--dsw-alias-state-business-primary)}"
			+ ".dsh-pins_row{width:calc(100% + 4px);min-height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:4px 10px 4px 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden;text-align:left;transition:background .15s ease}"
			+ ".dsh-pins_row:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".dsh-pins_rowIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-size:13px}"
			+ ".dsh-pins_rowText{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px;overflow:hidden}"
			+ ".dsh-pins_rowLabel{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsh-pins_rowSub{font-size:11px;line-height:15px;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums}"
			+ ".dsh-pins_popWrap{position:relative}"
			+ ".dsh-pins_pop{position:absolute;left:0;right:0;bottom:calc(100% + 6px);z-index:60;border:1px solid var(--dsw-alias-border-l2);border-radius:14px;background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1));box-shadow:0 10px 32px rgba(0,0,0,.28);padding:6px;display:flex;flex-direction:column;gap:1px;max-height:320px;overflow-y:auto}"
			+ ".dsh-pins_item{display:flex;align-items:center;gap:6px;border:none;background:0 0;border-radius:9px;padding:6px 8px;cursor:pointer;font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary);text-align:left;transition:background .12s ease}"
			+ ".dsh-pins_item:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".dsh-pins_itemTitle{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsh-pins_item[data-missing=true] .dsh-pins_itemTitle{color:var(--dsw-alias-label-tertiary);font-style:italic}"
			+ ".dsh-pins_itemPin{flex:none;opacity:.55;font-size:11px}"
			+ ".dsh-pins_itemX{flex:none;display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border:none;border-radius:6px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:11px;font-family:inherit}"
			+ ".dsh-pins_itemX:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-state-error-primary)}"
			+ ".dsh-pins_empty{padding:18px 12px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.7}"
			+ ".dsh-pins_error{padding:10px 12px;color:var(--dsw-alias-state-error-primary);font-size:12px}"
			+ "";
		var CSS_TAG_ID = "dsh-session-pins/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region shared pin store (RPC-backed, one per factory)
		var connection = null;
		var store = { pins: [], ready: false, error: null };
		var listeners = new Set();
		function notify() { listeners.forEach(function (fn) { fn(); }); }
		function setStore(patch) { store = Object.assign({}, store, patch); notify(); }
		function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
		function getSnapshot() { return store; }
		function usePins() { return useSyncExternalStore(subscribe, getSnapshot); }

		function rpc(endpoint, payload) {
			return connection.rpc.call("/session-pins", endpoint, payload || {}).then(function (result) {
				if (result === null || typeof result !== "object") throw new Error("session-pins: empty response");
				if (result.ok !== true) {
					var err = result.error;
					throw new Error((err && err.message) || "session-pins: request failed");
				}
				return result.value;
			});
		}
		function refresh() {
			return rpc("list").then(function (v) {
				setStore({ pins: v.pins || [], ready: true, error: null });
			}).catch(function (e) {
				setStore({ ready: true, error: String((e && e.message) || e) });
			});
		}
		function pinSession(sessionId, title) {
			return rpc("pin", { sessionId: sessionId, title: title || "" }).then(function (v) {
				setStore({ pins: v.pins || [], error: null });
			});
		}
		function unpinSession(sessionId) {
			return rpc("unpin", { sessionId: sessionId }).then(function (v) {
				setStore({ pins: v.pins || [], error: null });
			});
		}
		function listSnapshot(sessions) {
			try { return sessions && sessions.list && sessions.list.getSnapshot ? sessions.list.getSnapshot() : null; }
			catch (_) { return null; }
		}
		function titleOf(sessions, sessionId) {
			var snap = listSnapshot(sessions);
			var row = snap && snap.byId ? snap.byId[sessionId] : null;
			return row && row.displayTitle ? String(row.displayTitle) : "";
		}
		function isListed(sessions, sessionId) {
			var snap = listSnapshot(sessions);
			return Boolean(snap && snap.byId && snap.byId[sessionId]);
		}
		//#endregion

		//#region components
		function PinToggle(props) {
			var t = props.t;
			var sessions = props.sessions;
			var sessionId = props.sessionId;
			var pinsState = usePins();
			if (!sessionId) return null;
			var pinned = pinsState.pins.some(function (p) { return p.sessionId === sessionId; });
			var onClick = function () {
				if (pinned) { unpinSession(sessionId); return; }
				pinSession(sessionId, titleOf(sessions, sessionId));
			};
			return h("button", {
				type: "button",
				className: "dsh-pins_toggle",
				"data-pinned": pinned,
				title: pinned ? tx(t, "toggle.unpin") : tx(t, "toggle.pin"),
				onClick: onClick,
			}, "📌");
		}

		function PinsPanelEntry(props) {
			var t = props.t;
			var sessions = props.sessions;
			var pinsState = usePins();
			var openState = useState(false);
			var open = openState[0], setOpen = openState[1];
			var rootRef = useRef(null);
			useEffect(function () {
				if (!open) return undefined;
				var onDown = function (e) { if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false); };
				document.addEventListener("mousedown", onDown);
				return function () { document.removeEventListener("mousedown", onDown); };
			}, [open]);
			useEffect(function () {
				/* first mount + every window refocus keeps the panel fresh */
				refresh();
				var onFocus = function () { refresh(); };
				window.addEventListener("focus", onFocus);
				return function () { window.removeEventListener("focus", onFocus); };
			}, []);
			var count = pinsState.pins.length;
			var rows = pinsState.pins.map(function (p) {
				var listed = isListed(sessions, p.sessionId);
				var title = titleOf(sessions, p.sessionId) || p.title || p.sessionId;
				var openIt = function () {
					setOpen(false);
					try { sessions && sessions.open && sessions.open(p.sessionId); } catch (_) { /* unknown id: row stays */ }
				};
				var removeIt = function (e) {
					e.stopPropagation();
					unpinSession(p.sessionId);
				};
				return h("div", { key: p.sessionId, className: "dsh-pins_item", "data-missing": !listed, role: "button", tabIndex: 0, onClick: openIt },
					h("span", { className: "dsh-pins_itemPin" }, "📌"),
					h("span", { className: "dsh-pins_itemTitle", title: title }, title + (listed ? "" : " " + tx(t, "panel.missing"))),
					h("button", { type: "button", className: "dsh-pins_itemX", title: tx(t, "toggle.unpin"), onClick: removeIt }, "✕"));
			});
			return h("div", { className: "dsh-pins_popWrap", ref: rootRef },
				open && h("div", { className: "dsh-pins_pop", role: "menu" },
					pinsState.error !== null
						? h("div", { className: "dsh-pins_error" }, tx(t, "panel.error", { message: pinsState.error }))
						: rows.length === 0
							? h("div", { className: "dsh-pins_empty" }, tx(t, "panel.empty"))
							: rows),
				h("button", { type: "button", className: "dsh-pins_row", onClick: function () { setOpen(!open); } },
					h("span", { className: "dsh-pins_rowIcon" }, "📌"),
					h("span", { className: "dsh-pins_rowText" },
						h("span", { className: "dsh-pins_rowLabel" }, tx(t, "panel.label")),
						h("span", { className: "dsh-pins_rowSub" }, String(count)))));
		}
		//#endregion

		//#region registration
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "session-pins: dictionaries");
			var t = ctx.locale.bind(NS);
			connection = ctx.connection;
			/* Warm the store so the header toggle paints the right state. */
			refresh();
			ctx.slots.inject("conversation.session.header.actions", function () {
				return ctx.slots.register({
					name: "conversation.session.header.actions",
					id: "session-pins-toggle",
					order: 0,
					locale: NS,
					inject: function () { return { sessions: ctx.sessions }; },
				}, PinToggle);
			});
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "session-pins",
					order: 0,
					locale: NS,
					inject: function () { return { sessions: ctx.sessions }; },
				}, PinsPanelEntry);
			});
		}
		exports.name = "dsh-session-pins";
		exports.inject = ["slots", "locale", "connection", "sessions"];
		exports.apply = apply;
		//#endregion
		return module.exports;
	}
});
