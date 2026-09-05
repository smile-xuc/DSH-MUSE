/**
 * dsh-drop-path-ref — client entry (browser half).
 *
 * This file is NOT served directly. build/build-drop-path-ref.mjs concatenates
 * the tested pure helpers from lib/paths.mjs (exports stripped) with this
 * body into the committed ModuleLoader bundle at lib/client.js — edit here or
 * in paths.mjs and re-run the build, never edit lib/client.js by hand.
 *
 * Behavior:
 *  1. A capture-phase document `drop` listener runs before the stock
 *     attachment handler (document bubble). Pure non-image drops whose files
 *     resolve to absolute paths (WebKit uri-list / DownloadURL / plain text)
 *     are intercepted and inserted into the composer as path text; the stock
 *     "unsupported type" notice never fires.
 *  2. Drops containing stock-supported images are left untouched, and drops
 *     whose paths cannot be resolved fall through to stock behavior.
 *  3. `window.__dshDropPathRef.insertPaths(paths)` is exposed for the desktop
 *     shell's native drag bridge (which has real pasteboard URLs); the plugin
 *     reports readiness via the `dshDropPathRef` WKScriptMessage channel.
 */

//#region i18n
var NS = "drop-path-ref";
var zh = {
	"toast.inserted": "已把 {count} 个文件转为路径引用（该类型不支持作为附件）",
	"toast.noComposer": "找不到输入框——请先打开一个会话再拖入文件",
};
var en = {
	"toast.inserted": "Inserted {count} file(s) as path references (type not attachable)",
	"toast.noComposer": "No composer in view — open a conversation before dropping files",
};
var tRef = function (key) { return en[key] || key; };
function tx(t, key, params) {
	var out = t(key);
	if (out === key) out = en[key] || key;
	if (params) for (var k in params) out = out.replace("{" + k + "}", String(params[k]));
	return out;
}
//#endregion

//#region toast
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
	toastTimer = setTimeout(function () {
		if (toastEl) toastEl.style.opacity = "0";
	}, 2400);
}
//#endregion

//#region composer insertion
function findComposer() {
	var nodes = document.querySelectorAll('[contenteditable="true"]');
	for (var i = 0; i < nodes.length; i++) {
		var rect = nodes[i].getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0) return nodes[i];
	}
	return null;
}

/** Insert absolute paths as space-separated prompt text at the composer
 *  caret end. Returns false when no composer is visible (caller decides how
 *  to report; the drop is already consumed by then). */
function insertPaths(paths) {
	if (!Array.isArray(paths) || paths.length === 0) return false;
	var el = findComposer();
	if (el === null) {
		toast(tx(tRef, "toast.noComposer"));
		return false;
	}
	var text = paths.map(quotePath).join(" ") + " ";
	el.focus();
	var selection = window.getSelection();
	if (selection) {
		var range = document.createRange();
		range.selectNodeContents(el);
		range.collapse(false);
		selection.removeAllRanges();
		selection.addRange(range);
	}
	/* Lexical (the composer editor) observes beforeinput/input and syncs its
	 * model — execCommand insertText is the seam that flows through it. */
	document.execCommand("insertText", false, text);
	toast(tx(tRef, "toast.inserted", { count: paths.length }));
	return true;
}
//#endregion

//#region drop interception
function onDropCapture(event) {
	var dt = event.dataTransfer;
	if (!dt || !dt.types || dt.types.indexOf("Files") < 0) return;
	var files = [];
	for (var i = 0; dt.files && i < dt.files.length; i++) files.push(dt.files[i]);
	if (files.length === 0) return;
	/* Stock attach flow handles drops containing supported images — never
	 * intercept those, even in mixed drops. */
	if (files.some(isStockImage)) return;
	var paths = resolveDropPaths(dt, files);
	/* Paths unresolvable (e.g. Chromium exposes names only) → let the stock
	 * flow report "unsupported type" exactly as upstream does. */
	if (paths === null) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	insertPaths(paths);
}
//#endregion

//#region native bridge handshake
function postNative(state) {
	try {
		if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dshDropPathRef) {
			window.webkit.messageHandlers.dshDropPathRef.postMessage(state);
		}
	} catch (_) { /* not a WKWebView — the in-page resolver is the only path */ }
}
//#endregion

//#region registration
function apply(ctx) {
	ctx.effect(function () {
		return ctx.locale.register(NS, { zh: zh, en: en });
	}, "drop-path-ref: dictionaries");
	tRef = ctx.locale.bind(NS);
	document.addEventListener("drop", onDropCapture, true);
	window.__dshDropPathRef = { insertPaths: insertPaths };
	postNative("ready");
	ctx.effect(function () {
		return function () {
			document.removeEventListener("drop", onDropCapture, true);
			if (window.__dshDropPathRef && window.__dshDropPathRef.insertPaths === insertPaths) {
				delete window.__dshDropPathRef;
			}
			postNative("unready");
		};
	}, "drop-path-ref: drop capture");
}
exports.name = "dsh-drop-path-ref";
exports.inject = ["locale"];
exports.apply = apply;
//#endregion
