/**
 * dsh-session-pins (client half) — v0.2: native-feeling pin UX.
 *
 *  1. Entry: the session row menu (重命名 / 分叉会话 / 归档会话 — the same
 *     menu that renames a session) gains a 置顶会话/取消置顶 item. Upstream
 *     hard-codes that menu (no slot), so a throttled MutationObserver
 *     detects the portal menu by its fork item's label, resolves the session
 *     from the row carrying the menuOpen class + the live session list
 *     (title match, unique only), and clones the rename item's DOM for a
 *     pixel-consistent action row.
 *  2. Display: a 置顶会话 section is prepended to the sidebar's browsing
 *     region (`sidebar.workspaces` is a single-kind slot owned by the
 *     upstream browser, so the section lives as plain DOM above it), listing
 *     pinned sessions; click opens, ✕ unpins. Hidden while empty or in rail
 *     mode. The observer re-injects it if a React re-render removes it.
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

		//#region i18n
		var NS = "session-pins";
		var zh = {
			"menu.pin": "置顶会话",
			"menu.unpin": "取消置顶",
			"section.label": "置顶会话",
			"row.unpin": "取消置顶",
			"row.missing": "（已不在会话列表）",
			"toast.error": "置顶操作失败：{message}",
		};
		var en = {
			"menu.pin": "Pin session",
			"menu.unpin": "Unpin session",
			"section.label": "Pinned",
			"row.unpin": "Unpin",
			"row.missing": "(no longer listed)",
			"toast.error": "Pin action failed: {message}",
		};
		var tRef = function (key) { return en[key] || key; };
		function tx(key, params) {
			var out = tRef(key);
			if (out === key) out = en[key] || key;
			if (params) for (var k in params) out = out.replace("{" + k + "}", String(params[k]));
			return out;
		}
		//#endregion

		//#region upstream menu labels (detection contract, both locales)
		/* The session row menu is identified by its fork item (the workspace
		 * menu also has rename but never fork). Keep in sync with
		 * dsh-client-ui-workspace dictionaries. */
		var MENU_LABELS = [
			{ rename: "重命名", fork: "分叉会话" },
			{ rename: "Rename", fork: "Fork session" },
		];
		//#endregion

		//#region pins store (host RPC; records are { sessionId, title, pinnedAt })
		var connection = null;
		var sessionsSvc = null;
		var pins = [];
		var listeners = new Set();
		function emit() { listeners.forEach(function (fn) { try { fn(); } catch (_) {} }); }
		function subscribe(fn) { listeners.add(fn); return function () { listeners.delete(fn); }; }
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
			return rpc("list").then(function (value) {
				pins = (value && value.pins) || [];
				emit();
			}).catch(function () {});
		}
		function isPinned(id) { return pins.some(function (p) { return p.sessionId === id; }); }
		function togglePin(id, title) {
			var call = isPinned(id) ? rpc("unpin", { sessionId: id }) : rpc("pin", { sessionId: id, title: title });
			return call.then(function (value) {
				pins = (value && value.pins) || [];
				emit();
			}).catch(function (err) { toast(tx("toast.error", { message: err.message })); });
		}
		function liveTitle(id, fallback) {
			try {
				var row = sessionsSvc.list.getSnapshot().byId[id];
				if (row && row.displayTitle) return row.displayTitle;
			} catch (_) {}
			return fallback || id;
		}
		function sessionExists(id) {
			try { return !!sessionsSvc.list.getSnapshot().byId[id]; } catch (_) { return false; }
		}
		//#endregion

		//#region toast (shared minimal style with drop-path-ref)
		var toastEl = null;
		var toastTimer = 0;
		function toast(message) {
			if (toastEl === null) {
				toastEl = document.createElement("div");
				toastEl.style.cssText = "position:fixed;left:50%;bottom:88px;transform:translateX(-50%);z-index:9999;"
					+ "max-width:70vw;padding:8px 14px;border-radius:10px;pointer-events:none;"
					+ "font:13px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;"
					+ "color:var(--dsw-alias-label-primary,#e8e8e8);"
					+ "background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#2c2c2e));"
					+ "border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));"
					+ "box-shadow:0 8px 28px rgba(0,0,0,.35);opacity:0;transition:opacity .18s ease";
				document.body.appendChild(toastEl);
			}
			toastEl.textContent = message;
			requestAnimationFrame(function () { toastEl.style.opacity = "1"; });
			clearTimeout(toastTimer);
			toastTimer = setTimeout(function () { if (toastEl) toastEl.style.opacity = "0"; }, 2400);
		}
		//#endregion

		//#region pinned section (prepended above the sidebar browsing region)
		var SECTION_ATTR = "data-dsh-pins-section";
		var sectionEl = null;
		var regionWidth = 999;

		function findRegion() {
			return document.querySelector('[class*="_regionArea"]');
		}

		function renderSection() {
			if (sectionEl === null) return;
			sectionEl.style.display = (pins.length === 0 || regionWidth < 140) ? "none" : "block";
			var list = sectionEl.querySelector("[data-dsh-pins-list]");
			if (!list) return;
			list.textContent = "";
			pins.forEach(function (pin) {
				var row = document.createElement("div");
				row.style.cssText = "display:flex;align-items:center;gap:8px;min-height:32px;padding:4px 10px;margin:0 6px;"
					+ "border-radius:8px;cursor:pointer;font-size:13px;line-height:18px;"
					+ "color:var(--dsw-alias-label-primary,#e8e8e8)";

				var icon = document.createElement("span");
				icon.textContent = "📌";
				icon.style.cssText = "flex:none;font-size:12px";
				row.appendChild(icon);

				var label = document.createElement("span");
				var exists = sessionExists(pin.sessionId);
				label.textContent = liveTitle(pin.sessionId, pin.title);
				if (!exists) label.title = tx("row.missing");
				label.style.cssText = "flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"
					+ (exists ? "" : ";opacity:.45");
				row.appendChild(label);

				var unpin = document.createElement("button");
				unpin.type = "button";
				unpin.textContent = "✕";
				unpin.title = tx("row.unpin");
				unpin.style.cssText = "flex:none;border:none;background:0 0;cursor:pointer;font-size:11px;padding:2px 4px;"
					+ "border-radius:6px;color:var(--dsw-alias-label-tertiary,#999);visibility:hidden";
				unpin.onclick = function (e) {
					e.stopPropagation();
					togglePin(pin.sessionId, pin.title);
				};
				row.appendChild(unpin);

				row.onmouseenter = function () {
					row.style.background = "var(--dsw-alias-state-hover,rgba(128,128,128,.14))";
					unpin.style.visibility = "visible";
				};
				row.onmouseleave = function () {
					row.style.background = "transparent";
					unpin.style.visibility = "hidden";
				};
				row.onclick = function () {
					if (sessionExists(pin.sessionId)) sessionsSvc.open(pin.sessionId);
				};
				list.appendChild(row);
			});
		}

		function ensureSection() {
			var region = findRegion();
			if (region === null) return;
			if (sectionEl !== null && sectionEl.isConnected && sectionEl.parentElement === region) return;
			sectionEl = document.createElement("section");
			sectionEl.setAttribute(SECTION_ATTR, "");
			sectionEl.style.cssText = "flex:none;padding:4px 0 6px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.18));margin-bottom:4px";
			var head = document.createElement("div");
			head.setAttribute("data-dsh-pins-head", "");
			head.textContent = tx("section.label");
			head.style.cssText = "padding:2px 16px 4px;font-size:11px;font-weight:600;letter-spacing:.04em;"
				+ "color:var(--dsw-alias-label-tertiary,#999)";
			sectionEl.appendChild(head);
			var list = document.createElement("div");
			list.setAttribute("data-dsh-pins-list", "");
			sectionEl.appendChild(list);
			region.insertBefore(sectionEl, region.firstChild);
			renderSection();
		}
		//#endregion

		//#region session row menu injection
		var processedMenus = new WeakSet();

		function findForkButtons() {
			var out = [];
			var buttons = document.querySelectorAll("button");
			for (var i = 0; i < buttons.length; i++) {
				var text = (buttons[i].textContent || "").trim();
				for (var j = 0; j < MENU_LABELS.length; j++) {
					if (text === MENU_LABELS[j].fork) { out.push(buttons[i]); break; }
				}
			}
			return out;
		}

		/** The session whose row menu is open: the row carries the menuOpen
		 *  class; its title span matches exactly one session in the live list
		 *  (ambiguous titles → skip, the menu simply stays stock). */
		function openMenuSession() {
			var row = document.querySelector('[class*="_menuOpen"]');
			if (row === null) return null;
			var titleEl = row.querySelector('[class*="_title"]');
			var title = titleEl ? (titleEl.textContent || "").trim() : "";
			if (!title) return null;
			var snap = sessionsSvc.list.getSnapshot();
			var ids = Object.keys(snap.byId || {});
			var match = null;
			for (var i = 0; i < ids.length; i++) {
				var s = snap.byId[ids[i]];
				if ((s.displayTitle || "").trim() === title) {
					if (match !== null) return null; // ambiguous title — leave the menu stock
					match = { id: ids[i], title: title };
				}
			}
			return match;
		}

		/** Replace the clone's label WITHOUT guessing structure: find the leaf
		 *  element whose text is exactly the original label and rewrite only
		 *  its text. Falls back to a bare text node on the button. Returns
		 *  false (→ don't insert) when the label can't be located, so a
		 *  structural surprise leaves the menu stock instead of garbled. */
		function relabelClone(item, originalLabel, newLabel) {
			var all = item.querySelectorAll("*");
			for (var i = 0; i < all.length; i++) {
				var el = all[i];
				if (el.children.length === 0 && (el.textContent || "").trim() === originalLabel) {
					el.textContent = newLabel;
					return true;
				}
			}
			for (var n = 0; n < item.childNodes.length; n++) {
				var node = item.childNodes[n];
				if (node.nodeType === 3 && (node.textContent || "").trim() === originalLabel) {
					node.textContent = node.textContent.replace(originalLabel, newLabel);
					return true;
				}
			}
			return false;
		}

		function injectMenuItem(forkButton) {
			var menu = forkButton.parentElement;
			while (menu && menu.querySelectorAll("button").length < 2) menu = menu.parentElement;
			if (menu === null || processedMenus.has(menu)) return;
			processedMenus.add(menu);
			var session = openMenuSession();
			if (session === null) return;
			var renameBtn = null;
			var renameLabel = null;
			var buttons = menu.querySelectorAll("button");
			for (var i = 0; i < buttons.length; i++) {
				var text = (buttons[i].textContent || "").trim();
				for (var j = 0; j < MENU_LABELS.length; j++) {
					if (text === MENU_LABELS[j].rename) { renameBtn = buttons[i]; renameLabel = MENU_LABELS[j].rename; break; }
				}
				if (renameBtn) break;
			}
			if (renameBtn === null) return;

			var newLabel = isPinned(session.id) ? tx("menu.unpin") : tx("menu.pin");
			var item = renameBtn.cloneNode(true);
			/* Swap the icon (first svg) for a pin glyph sized to the svg's box. */
			var svg = item.querySelector("svg");
			if (svg) {
				var box = svg.getBoundingClientRect();
				var size = Math.max(12, Math.round(box.width || 16));
				var pin = document.createElement("span");
				pin.textContent = "📌";
				pin.style.cssText = "display:inline-flex;align-items:center;justify-content:center;"
					+ "width:" + size + "px;height:" + size + "px;font-size:" + (size - 4) + "px;line-height:1";
				svg.replaceWith(pin);
			}
			/* Rewrite only the label leaf; self-check before inserting. */
			if (!relabelClone(item, renameLabel, newLabel)) return;
			if ((item.textContent || "").indexOf(renameLabel) !== -1) return;
			item.addEventListener("click", function (e) {
				e.stopPropagation();
				e.preventDefault();
				togglePin(session.id, session.title);
				/* Close the upstream menu: Escape bubbles to React's root listener. */
				menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
			});
			renameBtn.parentElement.insertBefore(item, renameBtn.nextSibling);
		}

		function scanMenus() {
			var forks = findForkButtons();
			for (var i = 0; i < forks.length; i++) injectMenuItem(forks[i]);
		}
		//#endregion

		//#region observers (throttled; self-healing)
		var observer = null;
		var resizeObserver = null;
		var scanTimer = 0;
		function scheduleScan() {
			if (scanTimer) return;
			scanTimer = setTimeout(function () {
				scanTimer = 0;
				ensureSection();
				scanMenus();
			}, 200);
		}
		//#endregion

		//#region registration
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "session-pins: dictionaries");
			tRef = ctx.locale.bind(NS);
			connection = ctx.connection;
			sessionsSvc = ctx.sessions;

			refresh();
			var unsubscribeSessions = sessionsSvc.list.subscribe(function () { renderSection(); });
			var unsubscribePins = subscribe(renderSection);

			observer = new MutationObserver(scheduleScan);
			observer.observe(document.body, { childList: true, subtree: true });
			var region = findRegion();
			if (region) {
				regionWidth = region.getBoundingClientRect().width || regionWidth;
				resizeObserver = new ResizeObserver(function (entries) {
					regionWidth = entries[0].contentRect.width;
					renderSection();
				});
				resizeObserver.observe(region);
			}
			ensureSection();

			ctx.effect(function () {
				return function () {
					if (observer) observer.disconnect();
					if (resizeObserver) resizeObserver.disconnect();
					unsubscribeSessions();
					unsubscribePins();
					clearTimeout(scanTimer);
					if (sectionEl) sectionEl.remove();
					if (toastEl) toastEl.remove();
				};
			}, "session-pins: dom");
		}
		exports.name = "dsh-session-pins";
		exports.inject = ["locale", "connection", "sessions"];
		exports.apply = apply;
		//#endregion
		return module.exports;
	}
});
