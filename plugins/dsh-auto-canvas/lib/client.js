/**
 * dsh-auto-canvas (client half) — auto-opens the DSH Right Sidebar and displays
 * the canvas/preview in the in-app browser tab whenever an artifact or canvas
 * server URL (e.g. Baoyu Design /claude-design, /claude-slides, /claude-dashboard,
 * /claude-design-system, or local dev server) is detected in the conversation.
 *
 * Plain script in the `window.__ModuleLoader__` bundle format: no JSX, no
 * external dependencies beyond the browser module-table baseline.
 */
window.__ModuleLoader__.load({
	id: "dsh-auto-canvas",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region i18n
		var NS = "auto-canvas";
		var zh = {
			"toast.opened": "已在右侧栏自动展开画布",
			"toast.error": "自动打开画布失败：{message}",
		};
		var en = {
			"toast.opened": "Canvas auto-opened in right sidebar",
			"toast.error": "Failed to auto-open canvas: {message}",
		};
		var tRef = function (key) { return zh[key] || key; };
		function tx(key, params) {
			var out = tRef(key);
			if (out === key) out = en[key] || key;
			if (params) for (var k in params) out = out.replace("{" + k + "}", String(params[k]));
			return out;
		}
		//#endregion

		//#region Toast notification
		var toastEl = null;
		var toastTimer = 0;
		function showToast(message) {
			if (typeof document === "undefined") return;
			if (toastEl === null) {
				toastEl = document.createElement("div");
				toastEl.className = "dsh-auto-canvas-toast";
				toastEl.style.cssText = "position:fixed;bottom:72px;right:24px;z-index:9999;"
					+ "display:flex;align-items:center;gap:8px;padding:9px 16px;border-radius:12px;"
					+ "font:13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;"
					+ "color:var(--dsw-alias-label-primary,#e8e8e8);"
					+ "background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-1,#2c2c2e));"
					+ "border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.35));"
					+ "box-shadow:0 8px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);"
					+ "transition:all .22s cubic-bezier(0.16,1,0.3,1);pointer-events:none;";
				document.body.appendChild(toastEl);
			}
			toastEl.innerHTML = '<span style="font-size:16px">🎨</span><span style="font-weight:500">' + message + '</span>';
			requestAnimationFrame(() => {
				if (toastEl) {
					toastEl.style.opacity = "1";
					toastEl.style.transform = "translateY(0)";
				}
			});
			clearTimeout(toastTimer);
			toastTimer = setTimeout(() => {
				if (toastEl) {
					toastEl.style.opacity = "0";
					toastEl.style.transform = "translateY(8px)";
				}
			}, 2800);
		}
		//#endregion

		//#region URL Matching & Validation
		var LOCAL_URL_REGEX = /https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d{2,5})(?:\/[^\s<>"'`\)]*)?/gi;

		function normalizeCanvasUrl(rawUrl) {
			if (!rawUrl || typeof rawUrl !== "string") return null;
			var clean = rawUrl.trim().replace(/[.,;!?`"')\]]+$/, "");
			try {
				var parsed = new URL(clean);
				var host = parsed.hostname;
				if (host !== "127.0.0.1" && host !== "localhost") return null;
				var port = parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === "https:" ? 443 : 80);
				if (!port || port < 80) return null;

				// Exclude DSH web server itself if running on same port
				if (typeof window !== "undefined" && window.location) {
					if (parsed.port === window.location.port && parsed.hostname === window.location.hostname) {
						return null;
					}
				}

				// Exclude standard internal API routes
				if (parsed.pathname.startsWith("/api/") || parsed.pathname.startsWith("/ws")) {
					return null;
				}

				return parsed.href;
			} catch (_) {
				return null;
			}
		}
		//#endregion

		//#region State Tracking (per session)
		var sessionState = new Map();
		var isSwitchingSession = false;
		var switchTimer = 0;

		function getSessionState(sessionId) {
			if (!sessionId) return null;
			var state = sessionState.get(sessionId);
			if (!state) {
				state = {
					baseline: new Set(),
					opened: new Set(),
					initialized: false,
				};
				sessionState.set(sessionId, state);
			}
			return state;
		}

		function extractUrlsFromElement(element) {
			var urls = [];
			if (!element) return urls;

			// 1. Anchors
			if (element.tagName === "A" && element.href) {
				var n = normalizeCanvasUrl(element.href);
				if (n) urls.push(n);
			}
			var anchors = element.querySelectorAll ? element.querySelectorAll("a[href]") : [];
			for (var i = 0; i < anchors.length; i++) {
				var a = normalizeCanvasUrl(anchors[i].href);
				if (a) urls.push(a);
			}

			// 2. Text nodes (code blocks, markdown text)
			var text = element.textContent || "";
			var matches = text.match(LOCAL_URL_REGEX);
			if (matches) {
				for (var j = 0; j < matches.length; j++) {
					var u = normalizeCanvasUrl(matches[j]);
					if (u) urls.push(u);
				}
			}

			return urls;
		}
		//#endregion

		//#region Core Auto-Open Engine
		var currentCtx = null;
		var observer = null;
		var activeSessionId = null;

		function getRootService(name) {
			if (!currentCtx) return null;
			try {
				var root = currentCtx.root || currentCtx;
				if (root[name] !== undefined) return root[name];
				if (typeof root.get === "function") return root.get(name, false);
			} catch (_) {}
			return null;
		}

		function resolveActiveSessionId() {
			if (!currentCtx) return null;
			try {
				var root = currentCtx.root || currentCtx;
				if (root.uiSession?.adapter?.current) {
					var id = root.uiSession.adapter.current.getSnapshot()?.key;
					if (id) return id;
				}
				if (root.sidebarRight?.mounted) {
					var m = root.sidebarRight.mounted.getSnapshot();
					if (m) return m;
				}
			} catch (_) {}
			return null;
		}

		function triggerOpen(sessionId, url) {
			if (!url) return false;
			try {
				var root = (currentCtx && currentCtx.root) || currentCtx;
				var sidebar = root ? root.sidebarRight : null;
				var tabs = root ? root.sidebarRightTabs : null;
				if (!sidebar) {
					console.warn("[auto-canvas] sidebarRight service is not available on root context");
					return false;
				}

				if (!tabs || tabs.get("browser") === undefined) {
					console.warn("[auto-canvas] 'browser' tab type not yet available in sidebarRightTabs");
					return false;
				}

				var sid = sessionId || resolveActiveSessionId();
				console.log("[auto-canvas] auto-opening canvas in sidebar for session:", sid, url);

				// Ensure right sidebar column is expanded
				var expandBtn = document.querySelector("[data-sidebar-right-expand]");
				if (expandBtn) {
					try { expandBtn.click(); } catch (_) {}
				}

				if (sid && typeof sidebar.openTabIn === "function") {
					sidebar.openTabIn(sid, "browser", {
						params: { url: url },
						revealIfOpened: true,
					});
				} else if (typeof sidebar.openTab === "function") {
					sidebar.openTab("browser", {
						params: { url: url },
						revealIfOpened: true,
					});
				}

				showToast(tx("toast.opened"));
				return true;
			} catch (err) {
				console.error("[auto-canvas] error opening canvas tab:", err);
				return false;
			}
		}

		function processCandidates(urls) {
			var sid = resolveActiveSessionId();
			if (!sid || urls.length === 0) return;

			var state = getSessionState(sid);
			if (!state) return;

			if (isSwitchingSession || !state.initialized) {
				for (var k = 0; k < urls.length; k++) {
					state.baseline.add(urls[k]);
				}
				state.initialized = true;
				return;
			}

			for (var i = 0; i < urls.length; i++) {
				var url = urls[i];
				if (state.baseline.has(url)) continue;
				if (state.opened.has(url)) continue;

				state.opened.add(url);
				triggerOpen(sid, url);
				break;
			}
		}

		function onMutations(mutations) {
			var collected = [];
			for (var i = 0; i < mutations.length; i++) {
				var m = mutations[i];
				for (var j = 0; j < m.addedNodes.length; j++) {
					var node = m.addedNodes[j];
					if (node.nodeType === 1 || node.nodeType === 3) {
						var urls = extractUrlsFromElement(node);
						if (urls.length > 0) collected.push.apply(collected, urls);
					}
				}
			}
			if (collected.length > 0) {
				processCandidates(collected);
			}
		}
		//#endregion

		//#region Lifecycle & Registration
		function apply(ctx) {
			currentCtx = ctx;

			ctx.effect(() => {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "auto-canvas: dictionaries");
			tRef = ctx.locale.bind(NS);

			// Track session transitions
			var root = ctx.root || ctx;
			var uiSession = root.uiSession || getRootService("uiSession");
			if (uiSession?.adapter?.current) {
				ctx.effect(() => {
					var current = uiSession.adapter.current;
					var onSessionChange = () => {
						var nextId = current.getSnapshot()?.key;
						if (nextId !== activeSessionId) {
							activeSessionId = nextId;
							isSwitchingSession = true;
							clearTimeout(switchTimer);
							switchTimer = setTimeout(() => {
								isSwitchingSession = false;
								var sid = resolveActiveSessionId();
								if (sid) {
									var st = getSessionState(sid);
									var container = document.querySelector("[class*='scroll'], [class*='column'], main") || document.body;
									if (st && !st.initialized && container) {
										var existing = extractUrlsFromElement(container);
										for (var e = 0; e < existing.length; e++) st.baseline.add(existing[e]);
										st.initialized = true;
									}
								}
							}, 400);
						}
					};
					var unsubscribe = current.subscribe(onSessionChange);
					onSessionChange();
					return unsubscribe;
				}, "auto-canvas: session tracking");
			}

			// Observe conversation DOM changes
			if (typeof document !== "undefined") {
				observer = new MutationObserver(onMutations);
				observer.observe(document.body, { childList: true, subtree: true, characterData: true });

				// Initialize baseline for initial view
				setTimeout(() => {
					var sid = resolveActiveSessionId();
					if (sid) {
						var st = getSessionState(sid);
						var container = document.querySelector("[class*='scroll'], [class*='column'], main") || document.body;
						if (st && !st.initialized && container) {
							var existing = extractUrlsFromElement(container);
							for (var e = 0; e < existing.length; e++) st.baseline.add(existing[e]);
							st.initialized = true;
						}
					}
				}, 500);
			}

			// Expose bridge for diagnostics and external triggers
			if (typeof window !== "undefined") {
				window.__AUTO_CANVAS__ = {
					get ctx() { return currentCtx; },
					getSessionState: getSessionState,
					triggerOpen: triggerOpen,
					processCandidates: processCandidates,
					showToast: showToast,
					normalizeCanvasUrl: normalizeCanvasUrl,
				};
			}

			ctx.effect(() => {
				return function () {
					if (observer) observer.disconnect();
					observer = null;
					clearTimeout(switchTimer);
					if (toastEl) toastEl.remove();
					toastEl = null;
					sessionState.clear();
					currentCtx = null;
					if (typeof window !== "undefined") delete window.__AUTO_CANVAS__;
				};
			}, "auto-canvas: disposal");
		}

		exports.name = "dsh-auto-canvas";
		exports.inject = ["locale", "sessions"];
		exports.apply = apply;
		exports.normalizeCanvasUrl = normalizeCanvasUrl;
		exports.extractUrlsFromElement = extractUrlsFromElement;
		exports.getSessionState = getSessionState;
		//#endregion

		return module.exports;
	}
});
