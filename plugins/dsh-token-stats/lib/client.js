/**
 * dsh-token-stats (client half) — a `sidebar.footer.action` row (rendered by
 * the sidebar shell ABOVE the Settings seat) showing today's and this week's
 * total tokens, opening a modal with the complete per-day / per-week history.
 * Data comes from this package's host half over the loopback `/token-stats`
 * Connection RPC channel; the row re-reads it every minute.
 *
 * Plain script in the `window.__ModuleLoader__` bundle format: no JSX, no
 * imports — module ids resolve through the web shell's static module table.
 */
window.__ModuleLoader__.load({
	id: "dsh-token-stats",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var React = require("react");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var useState = React.useState;
		var useEffect = React.useEffect;
		var useCallback = React.useCallback;
		var h = React.createElement;

		//#region styles
		var CSS = ""
			/* ---- 侧栏徽标 ---- */
			+ ".dsh-token-stats_badge{width:calc(100% + 4px);min-height:42px;color:var(--dsw-alias-label-primary);cursor:pointer;background:0 0;border:none;border-radius:12px;align-items:center;gap:8px;margin:0 -2px;padding:4px 10px 4px 8px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden;text-align:left;transition:background .15s ease}"
			+ ".dsh-token-stats_badge:hover{background:var(--dsw-alias-interactive-bg-hover)}"
			+ ".dsh-token-stats_badgeIcon{flex:none;display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:8px;background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary)}"
			+ ".dsh-token-stats_badgeText{min-width:0;flex:1;display:flex;flex-direction:column;gap:1px;overflow:hidden}"
			+ ".dsh-token-stats_badgeLabel{font-size:13px;line-height:18px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsh-token-stats_badgeValue{font-size:11px;line-height:15px;color:var(--dsw-alias-label-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:ui-monospace,SFMono-Regular,\"SF Mono\",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums}"
			/* ---- 弹窗骨架 ---- */
			+ ".dsh-token-stats_dialog{max-width:680px;width:680px}"
			+ ".dsh-token-stats_empty{padding:32px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12px}"
			/* ---- 汇总卡片 ---- */
			+ ".dsh-token-stats_cards{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px}"
			+ ".dsh-token-stats_card{border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:11px 13px 10px;display:flex;flex-direction:column;gap:3px;min-width:0;transition:background .15s ease,border-color .15s ease}"
			+ ".dsh-token-stats_card:hover{background:rgba(127,127,127,.05)}"
			+ ".dsh-token-stats_cardLabel{font-size:12px;color:var(--dsw-alias-label-caption);display:flex;align-items:center;white-space:nowrap}"
			+ ".dsh-token-stats_dot{flex:none;display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:6px;background:var(--dsw-alias-label-tertiary)}"
			+ ".dsh-token-stats_card[data-accent=today] .dsh-token-stats_dot{background:var(--dsw-alias-state-business-primary)}"
			+ ".dsh-token-stats_card[data-accent=week] .dsh-token-stats_dot{background:var(--dsw-alias-state-success-primary)}"
			+ ".dsh-token-stats_card[data-accent=d7] .dsh-token-stats_dot{background:var(--dsw-alias-state-warn-primary)}"
			+ ".dsh-token-stats_cardValue{font-size:19px;font-weight:600;font-family:ui-monospace,SFMono-Regular,\"SF Mono\",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsh-token-stats_cardSub{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
			+ ".dsh-token-stats_trend{flex:none;margin-left:auto;font-size:10px;line-height:14px;padding:1px 6px;border-radius:7px;font-family:ui-monospace,SFMono-Regular,\"SF Mono\",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;white-space:nowrap}"
			+ ".dsh-token-stats_trendUp{color:var(--dsw-alias-state-warn-label);background:var(--dsw-alias-state-warn-tertiary)}"
			+ ".dsh-token-stats_trendDown{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-tertiary)}"
			+ ".dsh-token-stats_trendFlat{color:var(--dsw-alias-label-tertiary);background:rgba(127,127,127,.1)}"
			/* ---- 日/周切换 ---- */
			+ ".dsh-token-stats_toggle{display:inline-flex;gap:3px;margin-bottom:10px;border:1px solid var(--dsw-alias-border-l2);border-radius:9px;padding:2px}"
			+ ".dsh-token-stats_toggleBtn{border:none;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-family:inherit;font-size:12px;line-height:20px;padding:2px 12px;border-radius:7px;transition:background .15s ease,color .15s ease}"
			+ ".dsh-token-stats_toggleBtn[data-active=true]{background:var(--dsw-alias-state-business-tertiary);color:var(--dsw-alias-state-business-primary);font-weight:500}"
			/* ---- 表格（保留表格形态，提升可读性）---- */
			+ ".dsh-token-stats_tableWrap{max-height:340px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}"
			+ ".dsh-token-stats_table{width:100%;border-collapse:collapse;font-size:12px}"
			+ ".dsh-token-stats_table th{position:sticky;top:0;z-index:1;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-caption);font-weight:500;font-size:11px;letter-spacing:.3px;text-align:right;padding:7px 10px;white-space:nowrap}"
			+ ".dsh-token-stats_table th:first-child{text-align:left}"
			+ ".dsh-token-stats_table td{padding:6px 10px;text-align:right;font-family:ui-monospace,SFMono-Regular,\"SF Mono\",Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary);border-top:1px solid var(--dsw-alias-border-l2)}"
			+ ".dsh-token-stats_table td:first-child{text-align:left;font-family:inherit}"
			+ ".dsh-token-stats_table tbody tr:nth-child(even){background:rgba(127,127,127,.035)}"
			+ ".dsh-token-stats_table tbody tr{transition:background .12s ease}"
			+ ".dsh-token-stats_table tbody tr:hover{background:rgba(127,127,127,.08)}"
			+ ".dsh-token-stats_table td.dsh-token-stats_cacheRead{color:var(--dsw-alias-state-success-primary)}"
			+ ".dsh-token-stats_table td.dsh-token-stats_cacheWrite{color:var(--dsw-alias-label-caption)}"
			+ ".dsh-token-stats_todayChip{margin-left:6px;font-size:10px;line-height:14px;padding:0 6px;border-radius:7px;color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-tertiary);vertical-align:1px}"
			+ ".dsh-token-stats_cellTotal{display:flex;flex-direction:column;align-items:flex-end;gap:3px}"
			+ ".dsh-token-stats_cellBar{display:block;height:3px;min-width:2px;border-radius:2px;background:var(--dsw-alias-state-business-primary);opacity:.55}"
			/* ---- 底部状态行 ---- */
			+ ".dsh-token-stats_meta{display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:var(--dsw-alias-label-tertiary);margin-top:10px}"
			+ ".dsh-token-stats_metaSpacer{flex:1}"
			+ ".dsh-token-stats_refresh{border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:0 0;color:var(--dsw-alias-label-tertiary);cursor:pointer;display:inline-flex;align-items:center;gap:4px;font-family:inherit;font-size:11px;line-height:16px;padding:3px 10px;transition:color .15s ease,border-color .15s ease}"
			+ ".dsh-token-stats_refresh:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-caption)}"
			+ ".dsh-token-stats_error{color:var(--dsw-alias-state-error-primary);font-size:12px;margin-top:8px}"
			+ "";
		var CSS_TAG_ID = "dsh-token-stats/styles";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(CSS_TAG_ID) + "]") === null) {
			var tag = document.createElement("style");
			tag.dataset.plugin = "dsh-token-stats";
			tag.dataset.pluginCss = CSS_TAG_ID;
			tag.textContent = CSS;
			document.head.appendChild(tag);
		}
		//#endregion

		//#region locales
		var NS = "token-stats";
		var zh = {
			"row.label": "Token 统计",
			"row.tooltip": "Token 用量统计（点击看历史）",
			"row.today": "今日 {value}",
			"row.week": "本周 {value}",
			"row.empty": "暂无用量",
			"modal.title": "Token 用量统计",
			"card.today": "今日",
			"card.week": "本周",
			"card.last7": "近 7 天",
			"card.all": "全部历史",
			"card.inOut": "输入 {input} · 输出 {output}",
			"card.vsPrevDay": "较昨日 {value}",
			"tab.day": "按日",
			"tab.week": "按周",
			"table.date": "日期",
			"table.weekOf": "周（周一起）",
			"table.input": "输入",
			"table.output": "输出",
			"table.cacheRead": "缓存读取",
			"table.cacheWrite": "缓存写入",
			"table.total": "合计",
			"table.today": "今天",
			"table.empty": "还没有任何 token 用量记录",
			"meta.sessions": "{withUsage}/{count} 个会话有用量",
			"meta.updated": "更新于 {time}",
			"meta.refresh": "刷新",
			"meta.loading": "加载中…",
			"meta.error": "读取失败：{message}"
		};
		var en = {
			"row.label": "Tokens",
			"row.tooltip": "Token usage statistics (click for history)",
			"row.today": "Today {value}",
			"row.week": "Week {value}",
			"row.empty": "No usage yet",
			"modal.title": "Token usage",
			"card.today": "Today",
			"card.week": "This week",
			"card.last7": "Last 7 days",
			"card.all": "All time",
			"card.inOut": "In {input} · Out {output}",
			"card.vsPrevDay": "vs yesterday {value}",
			"tab.day": "By day",
			"tab.week": "By week",
			"table.date": "Date",
			"table.weekOf": "Week (Mon)",
			"table.input": "Input",
			"table.output": "Output",
			"table.cacheRead": "Cache read",
			"table.cacheWrite": "Cache write",
			"table.total": "Total",
			"table.today": "today",
			"table.empty": "No token usage recorded yet",
			"meta.sessions": "{withUsage}/{count} sessions with usage",
			"meta.updated": "Updated {time}",
			"meta.refresh": "Refresh",
			"meta.loading": "Loading…",
			"meta.error": "Failed to load: {message}"
		};
		//#endregion

		//#region formatting
		/** Compact figure for the sidebar row and cards: 12.3k / 1.2M. */
		function formatCompact(value) {
			if (value >= 1e6) return (value / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
			if (value >= 1e4) return Math.round(value / 1e3) + "k";
			if (value >= 1e3) return (value / 1e3).toFixed(1) + "k";
			return String(value);
		}
		/** Exact grouped figure for tables. */
		function formatExact(value) {
			return value.toLocaleString("en-US");
		}
		function formatClock(time) {
			var d = new Date(time);
			var p = function (n) { return String(n).padStart(2, "0"); };
			return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
		}
		/** Local-time day key — MUST mirror the host's dayKey() convention. */
		function dayKey(time) {
			var d = new Date(time);
			var p = function (n) { return String(n).padStart(2, "0"); };
			return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
		}
		//#endregion

		//#region data hook
		/**
		 * Poll the host aggregate. `intervalMs` re-reads on a timer; every read
		 * is cheap because the host caches per-log folds by file revision.
		 */
		function useTokenStats(fetchStats, intervalMs) {
			var state = useState(null);
			var stats = state[0];
			var setStats = state[1];
			var errState = useState(null);
			var error = errState[0];
			var setError = errState[1];
			var load = useCallback(function () {
				var cancelled = false;
				fetchStats().then(function (value) {
					if (cancelled) return;
					setStats(value);
					setError(null);
				}, function (err) {
					if (cancelled) return;
					setError(err instanceof Error ? err.message : String(err));
				});
				return function () { cancelled = true; };
			}, [fetchStats]);
			useEffect(function () {
				var dispose = load();
				var timer = window.setInterval(load, intervalMs);
				return function () {
					dispose();
					window.clearInterval(timer);
				};
			}, [load, intervalMs]);
			return { stats: stats, error: error, reload: load };
		}
		//#endregion

		//#region modal
		function SummaryCard(props) {
			return h("div", { className: "dsh-token-stats_card", "data-accent": props.accent },
				h("span", { className: "dsh-token-stats_cardLabel" },
					h("i", { className: "dsh-token-stats_dot" }),
					props.label,
					props.trend !== null && h("span", {
						className: "dsh-token-stats_trend " + props.trend.tone,
						title: props.t("card.vsPrevDay", { value: props.trend.signed })
					}, props.trend.text)),
				h("span", { className: "dsh-token-stats_cardValue", title: formatExact(props.row.total) }, formatCompact(props.row.total)),
				h("span", { className: "dsh-token-stats_cardSub" }, props.t("card.inOut", {
					input: formatCompact(props.row.input),
					output: formatCompact(props.row.output)
				})));
		}

		/**
		 * Trend of today vs the previous active day (days[] is newest-first).
		 * null when either side has no usage — the chip simply disappears.
		 */
		function todayTrend(stats, todayK) {
			var todayTotal = 0;
			var prevTotal = 0;
			for (var i = 0; i < stats.days.length; i++) {
				var row = stats.days[i];
				if (row.day === todayK) { todayTotal = row.total; continue; }
				if (row.day < todayK && prevTotal === 0) prevTotal = row.total;
			}
			if (todayTotal === 0 || prevTotal === 0) return null;
			var pct = Math.round((todayTotal - prevTotal) / prevTotal * 100);
			var abs = Math.abs(pct);
			return {
				tone: pct > 0 ? "dsh-token-stats_trendUp" : pct < 0 ? "dsh-token-stats_trendDown" : "dsh-token-stats_trendFlat",
				text: (pct > 0 ? "▲ " : pct < 0 ? "▼ " : "= ") + abs + "%",
				signed: (pct > 0 ? "+" : "") + pct + "%"
			};
		}

		function StatsTable(props) {
			var t = props.t;
			if (props.rows.length === 0) {
				return h("div", { className: "dsh-token-stats_empty" }, t("table.empty"));
			}
			var maxTotal = 1;
			for (var i = 0; i < props.rows.length; i++) {
				if (props.rows[i].total > maxTotal) maxTotal = props.rows[i].total;
			}
			return h("div", { className: "dsh-token-stats_tableWrap" },
				h("table", { className: "dsh-token-stats_table" },
					h("thead", null, h("tr", null,
						h("th", null, props.dateLabel),
						h("th", null, t("table.input")),
						h("th", null, t("table.output")),
						h("th", null, t("table.cacheRead")),
						h("th", null, t("table.cacheWrite")),
						h("th", null, t("table.total")))),
					h("tbody", null, props.rows.map(function (row) {
						var key = row[props.keyField];
						var pct = Math.max(2, Math.round(row.total / maxTotal * 100));
						return h("tr", { key: key },
							h("td", null,
								key,
								key === props.todayKey && h("span", { className: "dsh-token-stats_todayChip" }, t("table.today"))),
							h("td", null, formatExact(row.input)),
							h("td", null, formatExact(row.output)),
							h("td", { className: "dsh-token-stats_cacheRead" }, formatExact(row.cacheRead)),
							h("td", { className: "dsh-token-stats_cacheWrite" }, formatExact(row.cacheWrite)),
							h("td", null,
								h("span", { className: "dsh-token-stats_cellTotal" },
									h("span", null, formatExact(row.total)),
									h("i", { className: "dsh-token-stats_cellBar", style: { width: pct + "%" } }))));
					}))));
		}

		function TokenStatsModal(props) {
			var t = props.t;
			var tabState = useState("day");
			var tab = tabState[0];
			var setTab = tabState[1];
			var stats = props.stats;
			useEffect(function () {
				if (!props.open) return;
				var dispose = props.reload();
				var timer = window.setInterval(props.reload, 30000);
				return function () {
					dispose();
					window.clearInterval(timer);
				};
			}, [props.open, props.reload]);
			var todayK = dayKey(Date.now());
			return h(primitives.Modal, {
				open: props.open,
				onClose: props.onClose,
				title: t("modal.title"),
				className: "dsh-token-stats_dialog"
			},
				stats === null
					? h("div", { className: "dsh-token-stats_empty" }, t("meta.loading"))
					: h(React.Fragment, null,
						h("div", { className: "dsh-token-stats_cards" },
							h(SummaryCard, { t: t, label: t("card.today"), row: stats.totals.today, accent: "today", trend: todayTrend(stats, todayK) }),
							h(SummaryCard, { t: t, label: t("card.week"), row: stats.totals.thisWeek, accent: "week", trend: null }),
							h(SummaryCard, { t: t, label: t("card.last7"), row: stats.totals.last7Days, accent: "d7", trend: null }),
							h(SummaryCard, { t: t, label: t("card.all"), row: stats.totals.all, accent: "all", trend: null })),
						h("div", { className: "dsh-token-stats_toggle" },
							h("button", { type: "button", className: "dsh-token-stats_toggleBtn", "data-active": tab === "day" || undefined, onClick: function () { setTab("day"); } }, t("tab.day")),
							h("button", { type: "button", className: "dsh-token-stats_toggleBtn", "data-active": tab === "week" || undefined, onClick: function () { setTab("week"); } }, t("tab.week"))),
						tab === "day"
							? h(StatsTable, { t: t, rows: stats.days, keyField: "day", dateLabel: t("table.date"), todayKey: todayK })
							: h(StatsTable, { t: t, rows: stats.weeks, keyField: "week", dateLabel: t("table.weekOf"), todayKey: null }),
						h("div", { className: "dsh-token-stats_meta" },
							h("span", null, t("meta.sessions", { withUsage: stats.sessionsWithUsage, count: stats.sessionCount })),
							h("span", { className: "dsh-token-stats_metaSpacer" }),
							h("span", null, t("meta.updated", { time: formatClock(stats.generatedAt) })),
							h("button", { type: "button", className: "dsh-token-stats_refresh", onClick: function () { props.reload(); } },
								h(primitives.IconRefreshOutline14, { size: 12 }),
								t("meta.refresh")))),
				props.error !== null && h("div", { className: "dsh-token-stats_error" }, t("meta.error", { message: props.error })));
		}
		//#endregion

		//#region sidebar row
		function TokenStatsEntry(props) {
			var wide = props.wide;
			var t = props.t;
			var fetchStats = props.fetchStats;
			var openState = useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var result = useTokenStats(fetchStats, 60000);
			var stats = result.stats;
			var today = stats !== null ? stats.totals.today.total : 0;
			var week = stats !== null ? stats.totals.thisWeek.total : 0;
			var summary = stats === null
				? t("meta.loading")
				: today === 0 && week === 0
					? t("row.empty")
					: t("row.today", { value: formatCompact(today) }) + " · " + t("row.week", { value: formatCompact(week) });
			return h(React.Fragment, null,
				h(primitives.Tooltip, {
					label: t("row.tooltip") + " — " + summary,
					delayMs: 500,
					disabled: wide
				},
					h("button", {
						type: "button",
						className: "dsh-token-stats_badge",
						"aria-label": t("row.tooltip"),
						"aria-expanded": open,
						onClick: function () { setOpen(!open); }
					},
						h("span", { className: "dsh-token-stats_badgeIcon" },
							h(primitives.IconDataOutline16, { size: wide ? 15 : 17 })),
						wide && h("span", { className: "dsh-token-stats_badgeText" },
							h("span", { className: "dsh-token-stats_badgeLabel" }, t("row.label")),
							h("span", { className: "dsh-token-stats_badgeValue" }, summary)))),
				h(TokenStatsModal, {
					open: open,
					onClose: function () { setOpen(false); },
					t: t,
					stats: stats,
					error: result.error,
					reload: result.reload
				}));
		}
		//#endregion

		//#region registration
		var inject = ["slots", "locale", "connection"];
		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "token-stats: dictionaries");
			var connection = ctx.connection;
			var fetchStats = function () {
				return connection.rpc.call("/token-stats", "summary", {}).then(function (result) {
					if (result === null || typeof result !== "object") throw new Error("token-stats: empty response");
					if (result.ok !== true) {
						var err = result.error;
						throw new Error((err && err.message) || "token-stats: request failed");
					}
					return result.value;
				});
			};
			ctx.slots.inject("sidebar.footer.action", function () {
				return ctx.slots.register({
					name: "sidebar.footer.action",
					id: "token-stats",
					locale: NS,
					inject: function () {
						return { fetchStats: fetchStats };
					}
				}, TokenStatsEntry);
			});
		}
		exports.name = "dsh-token-stats";
		exports.inject = inject;
		exports.apply = apply;
		//#endregion
		return module.exports;
	}
});
