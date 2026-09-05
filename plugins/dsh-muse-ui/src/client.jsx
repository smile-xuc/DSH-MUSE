/**
 * dsh-muse-ui — browser half: the Muse 工作台 conversation view tab plus a
 * session-header progress chip.
 *
 * Two registrations:
 *  1. `conversation.view` (order 20, right of 轨迹): the full workbench.
 *  2. `conversation.session.header.actions`: a compact always-visible chip
 *     (status dot + steps progress + mini bar) reading the same `muse`
 *     projection via sessions.binding(id).projections.faceOf; clicking it
 *     jumps to the workbench tab.
 *
 * Workbench layout follows progressive disclosure:
 *
 *   首屏（一眼看懂）: 任务状态 + 目标 + 大进度条 + 步骤清单 → 交付物 → 最新动态
 *   技术细节（点击展开）: 统计 / 里程碑 / 预算仪表 / 副作用流水线 / 证据墙 / 评测 / 完整动态
 *
 * All graphics are hand-rolled CSS/SVG — no chart library, no externals
 * beyond the browser module-table baseline (react).
 *
 * @module dsh-muse-ui/client
 */
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { en, NS, zh } from './locales.js';

/** Required services: the conversation view slot, session bindings, locale. */
export const inject = ['slots', 'sessions', 'locale'];

/* ------------------------------------------------------------------------ */
/* Style (injected once per factory execution, like official bundles)       */
/* ------------------------------------------------------------------------ */

const STYLE_ID = 'dsh-muse-ui/styles';

const CSS = `
.muse-view { display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; padding: 14px 16px; overflow-y: auto; box-sizing: border-box; font-size: 12.5px; color: var(--dsw-alias-label-primary, #e8e8e8); }
.muse-view * { box-sizing: border-box; }
@keyframes muse-pulse { 0%,100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 45%, transparent); } 50% { box-shadow: 0 0 0 5px transparent; } }
@keyframes muse-breathe { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
/* ============ 首屏：Hero 任务卡 ============ */
.muse-hero { border: 1px solid var(--dsw-alias-border-l2, #303030); border-radius: 14px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); padding: 16px 18px 14px; display: flex; flex-direction: column; gap: 10px; }
.muse-hero-top { display: flex; align-items: center; gap: 10px; }
.muse-status { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; padding: 3px 12px 3px 8px; border-radius: 999px; flex: none; }
.muse-status .muse-status-dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
.muse-status.is-blue { color: var(--dsw-alias-state-business-primary, #4a7dff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 13%, transparent); }
.muse-status.is-blue .muse-status-dot { animation: muse-breathe 1.6s ease infinite; }
.muse-status.is-green { color: var(--dsw-alias-state-success-primary, #5cb85c); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 13%, transparent); }
.muse-status.is-amber { color: var(--dsw-alias-state-warn-label, #d90); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 12%, transparent); }
.muse-status.is-amber .muse-status-dot { animation: muse-breathe 2.2s ease infinite; }
.muse-status.is-red { color: var(--dsw-alias-state-error-primary, #f66); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 12%, transparent); }
.muse-status.is-dim { color: var(--dsw-alias-label-tertiary, #999); background: var(--dsw-alias-bg-layer-2, #2a2a2a); }
.muse-hero-objective { margin: 0; font-size: 14.5px; font-weight: 600; line-height: 1.55; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.muse-progress { display: flex; align-items: center; gap: 10px; }
.muse-progress-track { flex: 1; height: 8px; border-radius: 4px; background: var(--dsw-alias-bg-layer-2, #2c2c2c); overflow: hidden; }
.muse-progress-fill { height: 100%; border-radius: 4px; background: var(--dsw-alias-state-business-primary, #4a7dff); transition: width .5s ease; min-width: 0; }
.muse-progress.is-done .muse-progress-fill { background: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-progress.is-warn .muse-progress-fill { background: var(--dsw-alias-state-warn-label, #d90); }
.muse-progress.is-fail .muse-progress-fill { background: var(--dsw-alias-state-error-primary, #f66); }
.muse-progress-label { flex: none; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #bbb); }
/* 步骤清单（纵向、全标题、一眼可读） */
.muse-steplist { display: flex; flex-direction: column; gap: 2px; margin-top: 2px; }
.muse-steprow { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 9px; line-height: 1.45; }
.muse-steprow .muse-stepicon { flex: none; width: 20px; height: 20px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-style: normal; background: var(--dsw-alias-bg-layer-2, #2c2c2c); color: var(--dsw-alias-label-dimmed, #666); }
.muse-steprow .muse-steptitle { min-width: 0; overflow-wrap: anywhere; color: var(--dsw-alias-label-tertiary, #999); }
.muse-steprow.is-done .muse-stepicon { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 20%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-steprow.is-done .muse-steptitle { color: var(--dsw-alias-label-secondary, #bbb); }
.muse-steprow.is-in_progress { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 8%, transparent); }
.muse-steprow.is-in_progress .muse-stepicon { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 28%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-business-primary, #4a7dff); animation: muse-pulse 1.8s ease infinite; }
.muse-steprow.is-in_progress .muse-steptitle { color: var(--dsw-alias-label-primary, #eee); font-weight: 600; }
.muse-steprow.is-failed .muse-stepicon { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 22%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-error-primary, #f66); }
.muse-steprow.is-failed .muse-steptitle { color: var(--dsw-alias-state-error-primary, #f66); }
.muse-steprow.is-skipped .muse-stepicon { opacity: .45; }
.muse-steprow.is-skipped .muse-steptitle { opacity: .55; text-decoration: line-through; }
/* 警告条 */
.muse-alert { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 8px; font-weight: 600; animation: muse-breathe 2.2s ease infinite; }
.muse-alert.is-warn { color: var(--dsw-alias-state-warn-label, #d90); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 12%, transparent); }
.muse-alert.is-fail { color: var(--dsw-alias-state-error-primary, #f66); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 12%, transparent); animation: none; }
/* ============ 首屏：交付物卡 ============ */
.muse-card { border: 1px solid var(--dsw-alias-border-l2, #303030); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); padding: 12px 14px; }
.muse-card h4 { margin: 0 0 10px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-caption, #8a8a8a); display: flex; align-items: center; gap: 7px; }
.muse-card h4 .muse-count { margin-left: auto; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--dsw-alias-label-dimmed, #777); }
.muse-deliver-head { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.muse-deliver-head h4 { margin: 0; flex: 1; }
.muse-seal { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; font-weight: 600; padding: 3px 10px; border-radius: 999px; flex: none; }
.muse-seal.is-ok { color: var(--dsw-alias-state-success-primary, #5cb85c); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 13%, transparent); }
.muse-seal.is-wait { color: var(--dsw-alias-state-warn-label, #d90); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 11%, transparent); }
.muse-artifacts { display: flex; flex-wrap: wrap; gap: 6px; }
.muse-artifact { display: flex; gap: 6px; align-items: center; padding: 4px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #232323); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }
.muse-artifact .muse-art-check { color: var(--dsw-alias-state-success-primary, #5cb85c); font-weight: 700; }
.muse-artifact .muse-art-pending { color: var(--dsw-alias-label-dimmed, #888); }
/* ============ 首屏：最新动态一行 ============ */
.muse-latest { display: flex; align-items: center; gap: 9px; padding: 9px 14px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, #303030); background: var(--dsw-alias-bg-layer-1, #1d1d1d); font-size: 12px; }
.muse-latest .muse-latest-ico { flex: none; width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 10.5px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 17%, transparent); }
.muse-latest.is-write .muse-latest-ico { background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 17%, transparent); }
.muse-latest .muse-latest-label { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-secondary, #bbb); }
.muse-latest.is-denied .muse-latest-label { color: var(--dsw-alias-state-error-primary, #f66); }
.muse-latest .muse-latest-k { flex: none; color: var(--dsw-alias-label-dimmed, #888); font-size: 11px; }
/* ============ 技术细节（点击展开） ============ */
details.muse-tech { border: 1px solid var(--dsw-alias-border-l2, #303030); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); }
details.muse-tech > summary { cursor: pointer; list-style: none; padding: 11px 14px; font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-caption, #8a8a8a); display: flex; align-items: center; gap: 8px; border-radius: 12px; user-select: none; }
details.muse-tech > summary::-webkit-details-marker { display: none; }
details.muse-tech > summary::before { content: "▸"; display: inline-block; transition: transform .18s ease; color: var(--dsw-alias-label-dimmed, #777); }
details.muse-tech[open] > summary::before { transform: rotate(90deg); }
details.muse-tech > summary:hover { color: var(--dsw-alias-label-primary, #eee); }
details.muse-tech .muse-tech-body { display: flex; flex-direction: column; gap: 12px; padding: 2px 14px 14px; }
details.muse-tech .muse-card { background: var(--dsw-alias-bg-layer-2, #232323); }
/* 统计胶囊 */
.muse-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.muse-pill { display: flex; align-items: center; gap: 7px; padding: 5px 12px 5px 6px; border-radius: 999px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); border: 1px solid var(--dsw-alias-border-l2, #303030); }
.muse-pill .muse-ico { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; background: color-mix(in srgb, currentColor 16%, transparent); }
.muse-pill b { font-size: 13px; font-weight: 650; font-variant-numeric: tabular-nums; }
.muse-pill span { color: var(--dsw-alias-label-tertiary, #8f8f8f); }
.muse-pill.is-blue { color: var(--dsw-alias-state-business-primary, #4a7dff); }
.muse-pill.is-amber { color: var(--dsw-alias-state-warn-label, #d90); }
.muse-pill.is-green { color: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-pill.is-red { color: var(--dsw-alias-state-error-primary, #f66); }
.muse-pill.is-red b, .muse-pill.is-green b, .muse-pill.is-blue b, .muse-pill.is-amber b { color: var(--dsw-alias-label-primary, #eee); }
/* 里程碑轨道（技术区内） */
.muse-track { position: relative; display: flex; justify-content: space-between; margin: 6px 10px 2px; }
.muse-track::before { content: ""; position: absolute; top: 13px; left: 24px; right: 24px; height: 3px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2, #2c2c2c); }
.muse-track .muse-fill { position: absolute; top: 13px; left: 24px; height: 3px; border-radius: 2px; background: var(--dsw-alias-state-success-primary, #5cb85c); transition: width .5s ease; max-width: calc(100% - 48px); }
.muse-track.is-warn .muse-fill { background: var(--dsw-alias-state-warn-label, #d90); }
.muse-track.is-fail .muse-fill { background: var(--dsw-alias-state-error-primary, #f66); }
.muse-mile { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 72px; }
.muse-mile .muse-dot { width: 27px; height: 27px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; background: var(--dsw-alias-bg-layer-2, #2c2c2c); border: 2px solid transparent; color: var(--dsw-alias-label-dimmed, #666); }
.muse-mile.is-reached .muse-dot { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 22%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-mile.is-current .muse-dot { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 26%, var(--dsw-alias-bg-layer-2, #222)); border-color: var(--dsw-alias-state-business-primary, #4a7dff); animation: muse-pulse 1.8s ease infinite; color: var(--dsw-alias-state-business-primary, #4a7dff); }
.muse-track.is-warn .muse-mile.is-current .muse-dot { border-color: var(--dsw-alias-state-warn-label, #d90); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 26%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-warn-label, #d90); }
.muse-track.is-fail .muse-mile.is-current .muse-dot { border-color: var(--dsw-alias-state-error-primary, #f66); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 26%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-error-primary, #f66); animation: none; }
.muse-mile span { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f8f8f); }
.muse-mile.is-reached span, .muse-mile.is-current span { color: var(--dsw-alias-label-primary, #eee); font-weight: 600; }
/* 预算仪表 */
.muse-budget { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.muse-gauge { display: flex; align-items: center; gap: 9px; }
.muse-gauge svg { display: block; }
.muse-gauge .muse-gauge-text { display: flex; flex-direction: column; gap: 1px; }
.muse-gauge .muse-gauge-text b { font-size: 12px; font-variant-numeric: tabular-nums; }
.muse-gauge .muse-gauge-text span { font-size: 10.5px; color: var(--dsw-alias-label-dimmed, #888); }
.muse-gauge.is-warn circle.val { stroke: var(--dsw-alias-state-warn-label, #d90); }
.muse-gauge.is-over circle.val { stroke: var(--dsw-alias-state-error-primary, #f66); }
/* 网格 */
.muse-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12px; }
@media (max-width: 900px) { .muse-grid { grid-template-columns: 1fr; } }
/* 流水线 */
.muse-lines { display: flex; flex-direction: column; gap: 7px; }
.muse-eff { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); }
details.muse-tech .muse-eff, details.muse-tech .muse-evi { background: var(--dsw-alias-bg-layer-1, #1d1d1d); }
.muse-eff.is-denied { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 10%, var(--dsw-alias-bg-layer-1, #1d1d1d)); }
.muse-eff .muse-ico { width: 26px; height: 26px; border-radius: 8px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 13px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 15%, transparent); }
.muse-eff .muse-eff-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.muse-eff .muse-eff-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.muse-eff .muse-eff-sub { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--dsw-alias-label-dimmed, #777); }
.muse-eff .muse-eff-sub .muse-origin { border: 1px solid var(--dsw-alias-border-l2, #363636); border-radius: 6px; padding: 0 5px; }
.muse-stations { position: relative; display: flex; gap: 10px; align-items: center; flex: none; }
.muse-stations i { width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-bg-layer-2, #3a3a3a); border: 1px solid var(--dsw-alias-border-l2, #444); }
.muse-stations i.on-amber { background: var(--dsw-alias-state-warn-label, #d90); border-color: transparent; }
.muse-stations i.on-green { background: var(--dsw-alias-state-success-primary, #5cb85c); border-color: transparent; }
.muse-stations i.on-blue { background: var(--dsw-alias-state-business-primary, #4a7dff); border-color: transparent; animation: muse-breathe 1.4s ease infinite; }
.muse-stations i.on-red { background: var(--dsw-alias-state-error-primary, #f66); border-color: transparent; }
/* 证据墙 */
.muse-evi { display: flex; gap: 9px; align-items: flex-start; padding: 7px 9px; border-radius: 9px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); }
.muse-evi .muse-ico { width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 12px; }
.muse-evi.is-trusted .muse-ico { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 16%, transparent); }
.muse-evi.is-untrusted .muse-ico { background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 16%, transparent); }
.muse-evi .muse-evi-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.muse-evi .muse-evi-claim { line-height: 1.45; font-size: 11.5px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.muse-evi .muse-evi-sub { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--dsw-alias-label-dimmed, #777); }
.muse-tag { border-radius: 6px; padding: 0 5px; font-size: 10px; line-height: 16px; }
.muse-tag.is-green { color: var(--dsw-alias-state-success-primary, #5cb85c); background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 13%, transparent); }
.muse-tag.is-amber { color: var(--dsw-alias-state-warn-label, #d90); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 13%, transparent); }
.muse-tag.is-red { color: var(--dsw-alias-state-error-primary, #f66); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 13%, transparent); }
.muse-tag.is-blue { color: var(--dsw-alias-state-business-primary, #4a7dff); background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 13%, transparent); }
.muse-tag.is-dim { color: var(--dsw-alias-label-dimmed, #888); background: var(--dsw-alias-bg-layer-2, #2a2a2a); }
.muse-hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 9.5px; color: var(--dsw-alias-label-dimmed, #666); }
.muse-note { color: var(--dsw-alias-label-dimmed, #888); font-size: 11.5px; line-height: 1.5; margin: 0; }
/* 评测瓦片 */
.muse-eval { display: flex; gap: 8px; flex-wrap: wrap; }
.muse-tile { display: flex; flex-direction: column; gap: 1px; padding: 5px 11px; border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); }
.muse-tile b { font-size: 13px; font-variant-numeric: tabular-nums; }
.muse-tile span { font-size: 10px; color: var(--dsw-alias-label-dimmed, #888); }
/* 动态 feed */
.muse-feed .muse-lines { max-height: 220px; overflow-y: auto; gap: 5px; }
.muse-feed-row { display: flex; gap: 9px; align-items: center; min-width: 0; }
.muse-feed-row .muse-ico { width: 22px; height: 22px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 10.5px; }
.muse-feed-row.is-muse .muse-ico { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 17%, transparent); }
.muse-feed-row.is-write .muse-ico { background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 17%, transparent); }
.muse-feed-row .muse-feed-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #bbb); }
.muse-feed-row.is-denied .muse-feed-label { color: var(--dsw-alias-state-error-primary, #f66); }
.muse-feed-row .muse-loc { flex: none; font-size: 9.5px; color: var(--dsw-alias-label-dimmed, #5f5f5f); font-variant-numeric: tabular-nums; }
/* 空态 */
.muse-empty { margin: auto; max-width: 430px; text-align: center; color: var(--dsw-alias-label-tertiary, #999); display: flex; flex-direction: column; gap: 10px; align-items: center; }
.muse-empty h3 { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #bbb); }
.muse-empty p { margin: 0; line-height: 1.65; }
.muse-orbit { position: relative; width: 84px; height: 84px; }
.muse-orbit i { position: absolute; border-radius: 50%; border: 1.5px dashed var(--dsw-alias-border-l2, #3a3a3a); animation: muse-spin 14s linear infinite; }
.muse-orbit i:nth-child(1) { inset: 0; }
.muse-orbit i:nth-child(2) { inset: 12px; animation-duration: 9s; animation-direction: reverse; }
.muse-orbit i:nth-child(3) { inset: 24px; animation-duration: 6s; }
.muse-orbit b { position: absolute; inset: 33px; border-radius: 50%; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 25%, transparent); animation: muse-breathe 2.4s ease infinite; }
@keyframes muse-spin { to { transform: rotate(360deg); } }
/* ============ 会话头部横向进度条 ============ */
.muse-bar { order: -1; display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l2, #303030); background: var(--dsw-alias-bg-layer-1, #1d1d1d); cursor: pointer; font-family: inherit; font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-secondary, #bbb); transition: border-color .15s ease, background .15s ease; }
.muse-bar:hover { border-color: var(--dsw-alias-label-caption, #8a8a8a); background: var(--dsw-alias-interactive-bg-hover, #2a2a2a); }
.muse-bar .muse-bar-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, #999); }
.muse-bar .muse-bar-status { flex: none; }
.muse-bar .muse-bar-steps { flex: none; color: var(--dsw-alias-label-tertiary, #999); font-weight: 500; }
.muse-bar .muse-bar-track { flex: none; width: 64px; height: 4px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2, #2c2c2c); overflow: hidden; }
.muse-bar .muse-bar-track i { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-state-business-primary, #4a7dff); transition: width .4s ease; }
.muse-bar.is-standby { opacity: .7; border-style: dashed; }
.muse-bar.is-standby:hover { opacity: 1; border-style: solid; }
.muse-bar.is-blue .muse-bar-dot { background: var(--dsw-alias-state-business-primary, #4a7dff); animation: muse-breathe 1.6s ease infinite; }
.muse-bar.is-green .muse-bar-dot { background: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-bar.is-green .muse-bar-track i { background: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-bar.is-amber .muse-bar-dot { background: var(--dsw-alias-state-warn-label, #d90); animation: muse-breathe 2.2s ease infinite; }
.muse-bar.is-amber .muse-bar-track i { background: var(--dsw-alias-state-warn-label, #d90); }
.muse-bar.is-red .muse-bar-dot { background: var(--dsw-alias-state-error-primary, #f66); }
.muse-bar.is-red .muse-bar-track i { background: var(--dsw-alias-state-error-primary, #f66); }
.muse-bar-root { position: relative; order: -1; display: inline-flex; }
.muse-pop { position: absolute; top: 36px; right: 0; z-index: 60; width: 256px; max-height: min(480px, calc(100vh - 160px)); overflow-y: auto; padding: 13px 14px 11px; border-radius: 13px; border: 1px solid var(--dsw-alias-border-l2, #303030); background: var(--dsw-alias-bg-layer-1, #1d1d1d); box-shadow: 0 12px 40px rgba(0,0,0,.4); }
.muse-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 9px; }
.muse-pop-title { font-size: 11px; font-weight: 700; letter-spacing: .6px; color: var(--dsw-alias-label-tertiary, #999); }
.muse-pop-obj { margin: 8px 0 10px; font-size: 12px; line-height: 1.55; color: var(--dsw-alias-label-secondary, #bbb); display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.muse-pop-steps { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 5px; }
.muse-pop-step { display: flex; align-items: center; gap: 8px; font-size: 11.5px; line-height: 1.4; color: var(--dsw-alias-label-tertiary, #999); }
.muse-pop-step > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.muse-pop-step.is-done { color: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-pop-step.is-run { color: var(--dsw-alias-state-business-primary, #4a7dff); font-weight: 600; }
.muse-pop-step.is-bad { color: var(--dsw-alias-state-error-primary, #f66); }
.muse-pop-step i { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-border-l2, #303030); }
.muse-pop-step.is-done i { background: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-pop-step.is-run i { background: var(--dsw-alias-state-business-primary, #4a7dff); animation: muse-breathe 1.6s ease infinite; }
.muse-pop-step.is-bad i { background: var(--dsw-alias-state-error-primary, #f66); }
.muse-pop-open { margin-top: 11px; width: 100%; height: 28px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #303030); background: var(--dsw-alias-bg-layer-2, #2c2c2c); color: var(--dsw-alias-label-secondary, #bbb); font-size: 11.5px; font-weight: 600; cursor: pointer; font-family: inherit; }
.muse-pop-open:hover { background: var(--dsw-alias-interactive-bg-hover, #2a2a2a); color: var(--dsw-alias-label-primary, #eee); }
`;

function ensureStyles() {
  if (typeof document === 'undefined') return;
  if (document.getElementById(STYLE_ID) !== null) return;
  const tag = document.createElement('style');
  tag.id = STYLE_ID;
  tag.dataset.plugin = 'dsh-muse-ui';
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/* ------------------------------------------------------------------------ */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------ */

const STEP_ICON = { pending: '·', in_progress: '◐', done: '✓', failed: '✕', skipped: '↷' };
const ACTION_ICON = { 'fs.write': '✏️', 'fs.edit': '📝', 'shell.exec': '⚡' };

/** Map workunit status onto the 4-milestone journey. */
function journey(status, hasVerification) {
  switch (status) {
    case 'draft': return { reach: 0, current: 0, tone: 'ok' };
    case 'active': return { reach: 1, current: 1, tone: 'ok' };
    case 'waiting_approval':
    case 'blocked': return { reach: 1, current: 1, tone: 'warn' };
    case 'done': return { reach: 3, current: null, tone: 'ok' };
    case 'failed':
    case 'cancelled': return { reach: hasVerification ? 2 : 1, current: hasVerification ? 2 : 1, tone: 'fail' };
    default: return { reach: 0, current: 0, tone: 'ok' };
  }
}

/** Status chip tone + icon for the hero (plain-language first screen). */
function statusTone(status) {
  switch (status) {
    case 'active': return 'is-blue';
    case 'done': return 'is-green';
    case 'waiting_approval':
    case 'blocked': return 'is-amber';
    case 'failed':
    case 'cancelled': return 'is-red';
    default: return 'is-dim';
  }
}

/** Station fill states per effect status: [propose, ledger, execute]. */
function stations(status) {
  switch (status) {
    case 'proposed': return ['amber', '', ''];
    case 'approved': return ['amber', 'amber', ''];
    case 'executing': return ['amber', 'amber', 'blue'];
    case 'executed': return ['green', 'green', 'green'];
    case 'failed': return ['amber', 'amber', 'red'];
    case 'denied': return ['amber', 'amber', 'red'];
    case 'rolled_back': return ['dim', 'dim', 'dim'];
    default: return ['', '', ''];
  }
}

function formatTokens(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function shortPath(path) {
  const text = String(path ?? '');
  return text.length <= 34 ? text : `…${text.slice(-33)}`;
}

/** Translate with a fallback when the key is missing from the dictionary. */
function tx(t, key, fallback) {
  const value = t(key);
  return value === undefined || value === null || value === key ? fallback : value;
}

/* ------------------------------------------------------------------------ */
/* 首屏 sections                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Hero: plain-language task state at a glance — status chip, objective,
 * one big progress bar (steps done/total), then the step checklist with
 * full titles. The current step breathes; failed steps go red.
 */
function HeroCard({ unit, t }) {
  if (unit == null) {
    return (
      <section className="muse-hero">
        <div className="muse-hero-top">
          <span className="muse-status is-dim"><i className="muse-status-dot" />{t('hero.status.none')}</span>
        </div>
        <p className="muse-note">{t('journey.none')}</p>
      </section>
    );
  }
  const status = unit.status ?? 'draft';
  const tone = statusTone(status);
  const steps = unit.steps ?? [];
  const done = steps.filter((s) => s.status === 'done').length;
  const trip = journey(status, unit.verification != null);
  /* progress: precise step ratio when a plan exists, else coarse milestone */
  const pct = steps.length > 0
    ? Math.round((done / steps.length) * 100)
    : (status === 'done' ? 100 : Math.round((trip.reach / 3) * 100));
  const progressTone = trip.tone === 'fail' ? 'is-fail' : trip.tone === 'warn' ? 'is-warn' : status === 'done' ? 'is-done' : '';
  const alertKey = trip.tone === 'warn' ? `journey.alert.${status}` : trip.tone === 'fail' ? `journey.${status}` : null;

  return (
    <section className="muse-hero">
      <div className="muse-hero-top">
        <span className={`muse-status ${tone}`}><i className="muse-status-dot" />{tx(t, `hero.status.${status}`, status)}</span>
        {(unit.constraints?.length ?? 0) > 0 && (
          <span className="muse-note" title={unit.constraints.join('\n')}>📎 {t('journey.constraints')} × {unit.constraints.length}</span>
        )}
      </div>
      <p className="muse-hero-objective" title={unit.objective}>{unit.objective ?? '—'}</p>
      <div className={`muse-progress${progressTone ? ` ${progressTone}` : ''}`}>
        <div className="muse-progress-track"><div className="muse-progress-fill" style={{ width: `${pct}%` }} /></div>
        <span className="muse-progress-label">
          {steps.length > 0 ? t('hero.progress', { done, total: steps.length, pct }) : `${pct}%`}
        </span>
      </div>
      {alertKey != null && (
        <div className={`muse-alert is-${trip.tone === 'warn' ? 'warn' : 'fail'}`}>
          {trip.tone === 'warn' ? '⏳' : '⛔'} {t(alertKey)}
        </div>
      )}
      {steps.length > 0 && (
        <div className="muse-steplist">
          {steps.map((step, index) => (
            <div key={step.id ?? index} className={`muse-steprow is-${step.status}`} title={step.note ?? undefined}>
              <i className="muse-stepicon">{step.status === 'pending' ? index + 1 : STEP_ICON[step.status] ?? '·'}</i>
              <span className="muse-steptitle">{step.title}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/** Deliverables front and center: verification seal + artifact chips. */
function ArtifactsCard({ unit, effects, t }) {
  const verified = unit?.verification != null;
  const artifacts = unit?.artifacts ?? [];
  const fileEffects = (effects ?? []).filter((e) => (e.action === 'fs.write' || e.action === 'fs.edit') && (e.status === 'executed' || e.status === 'executing'));
  const fallbackPaths = artifacts.length === 0
    ? [...new Set(fileEffects.map((e) => e.resource).filter(Boolean))]
    : [];
  return (
    <section className="muse-card">
      <div className="muse-deliver-head">
        <h4>📦 {t('delivery.artifacts')}</h4>
        <span className={`muse-seal ${verified ? 'is-ok' : 'is-wait'}`}>
          {verified ? `✓ ${t('delivery.verified')}` : `… ${t('delivery.unverified')}`}
        </span>
      </div>
      {artifacts.length === 0 && fallbackPaths.length === 0
        ? <p className="muse-note">{t('artifacts.empty')}</p>
        : (
          <div className="muse-artifacts">
            {artifacts.map((artifact) => (
              <span key={artifact.id ?? artifact.path} className="muse-artifact" title={artifact.path}>
                📄 {shortPath(artifact.path)}
                <span className={verified ? 'muse-art-check' : 'muse-art-pending'}>{verified ? '✓' : '…'}</span>
              </span>
            ))}
            {fallbackPaths.map((path) => (
              <span key={path} className="muse-artifact" title={`${path} (来自台账)`}>
                📝 {shortPath(path)}
                <span className={verified ? 'muse-art-check' : 'muse-art-pending'}>{verified ? '✓' : '…'}</span>
              </span>
            ))}
          </div>
        )}
    </section>
  );
}

/** One plain-language line: what just happened. */
function LatestRow({ activity, t }) {
  const latest = activity.length > 0 ? activity[activity.length - 1] : null;
  if (latest == null) return null;
  return (
    <div className={`muse-latest is-${latest.kind}${latest.status === 'denied' ? ' is-denied' : ''}`}>
      <span className="muse-latest-ico">{latest.kind === 'muse' ? '◎' : '✎'}</span>
      <span className="muse-latest-k">{t('latest.prefix')}</span>
      <span className="muse-latest-label">{latest.label}</span>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* 技术细节 sections（默认折叠）                                                */
/* ------------------------------------------------------------------------ */

function StatPills({ muse, t }) {
  const stats = muse.stats ?? {};
  const pills = [
    { icon: '◎', tone: 'is-blue', value: stats.museCalls ?? 0, label: t('stats.museCalls') },
    { icon: '✎', tone: 'is-amber', value: stats.writeOps ?? 0, label: t('stats.writeOps') },
    { icon: '✓', tone: 'is-green', value: stats.executed ?? 0, label: t('stats.executed') },
    { icon: '🛡', tone: 'is-red', value: stats.denied ?? 0, label: t('stats.denied') },
    { icon: '✕', tone: 'is-red', value: stats.failed ?? 0, label: t('stats.failed') },
  ];
  return (
    <div className="muse-pills">
      {pills.map((pill) => (
        <span key={pill.label} className={`muse-pill ${pill.tone}`}>
          <span className="muse-ico">{pill.icon}</span>
          <b>{pill.value}</b>
          <span>{pill.label}</span>
        </span>
      ))}
    </div>
  );
}

function Gauge({ ratio, tone, value, label }) {
  const clamped = Math.max(0, Math.min(1, ratio || 0));
  const circumference = 2 * Math.PI * 15;
  return (
    <div className={`muse-gauge${tone ? ` ${tone}` : ''}`}>
      <svg width="36" height="36" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r="15" fill="none" stroke="var(--dsw-alias-bg-layer-2, #2c2c2c)" strokeWidth="4" />
        <circle className="val" cx="18" cy="18" r="15" fill="none" stroke="var(--dsw-alias-state-business-primary, #4a7dff)" strokeWidth="4" strokeLinecap="round"
          strokeDasharray={`${clamped * circumference} ${circumference}`} transform="rotate(-90 18 18)" />
      </svg>
      <span className="muse-gauge-text"><b>{value}</b><span>{label}</span></span>
    </div>
  );
}

/** Milestone track + budget gauges (technical layer). */
function JourneyTechCard({ unit, t }) {
  if (unit == null) return null;
  const trip = journey(unit.status, unit.verification != null);
  const milestones = ['draft', 'active', 'verify', 'done'];
  const fillPercent = trip.current === null ? 100 : (trip.current / (milestones.length - 1)) * 100;
  const budget = unit.budget ?? {};
  const tokenRatio = budget.maxTokens ? (budget.spentTokens ?? 0) / budget.maxTokens : 0;
  const failureRatio = budget.maxFailures ? (budget.failures ?? 0) / budget.maxFailures : 0;
  const roundRatio = budget.maxRounds ? (budget.roundsUsed ?? 0) / budget.maxRounds : 0;
  return (
    <section className="muse-card">
      <h4>🧭 {t('journey.title')}<span className="muse-count">v{unit.planVersion ?? 0}</span></h4>
      <div className={`muse-track${trip.tone === 'ok' ? '' : ` is-${trip.tone}`}`}>
        <div className="muse-fill" style={{ width: `calc(${fillPercent}% )` }} />
        {milestones.map((key, index) => {
          const reached = index < trip.reach || (trip.current === null && index <= trip.reach);
          const isCurrent = index === trip.current;
          return (
            <div key={key} className={`muse-mile${reached ? ' is-reached' : ''}${isCurrent ? ' is-current' : ''}`}>
              <div className="muse-dot">{reached && !isCurrent ? '✓' : isCurrent ? (trip.tone === 'fail' ? '✕' : '◐') : index + 1}</div>
              <span>{t(`milestone.${key}`)}</span>
            </div>
          );
        })}
      </div>
      <div className="muse-budget" style={{ marginTop: 12 }}>
        <Gauge ratio={tokenRatio} tone={tokenRatio > 0.9 ? 'is-over' : tokenRatio > 0.7 ? 'is-warn' : ''}
          value={`${formatTokens(budget.spentTokens)}/${formatTokens(budget.maxTokens)}`} label={t('journey.budget.tokens')} />
        <Gauge ratio={failureRatio} tone={failureRatio >= 1 ? 'is-over' : failureRatio >= 0.5 ? 'is-warn' : ''}
          value={`${budget.failures ?? 0}${budget.maxFailures != null ? `/${budget.maxFailures}` : ''}`} label={t('journey.budget.failures')} />
        {budget.maxRounds != null && (
          <Gauge ratio={roundRatio} tone={roundRatio >= 1 ? 'is-over' : roundRatio >= 0.7 ? 'is-warn' : ''}
            value={`${budget.roundsUsed ?? 0}/${budget.maxRounds}`} label={t('journey.budget.rounds')} />
        )}
      </div>
    </section>
  );
}

function EffectRow({ effect, t }) {
  const fill = stations(effect.status);
  return (
    <div className={`muse-eff${effect.status === 'denied' ? ' is-denied' : ''}`} title={`${effect.action} ${effect.resource}${effect.note ? `\n${effect.note}` : ''}`}>
      <span className="muse-ico">{ACTION_ICON[effect.action] ?? '🔧'}</span>
      <span className="muse-eff-main">
        <span className="muse-eff-path">{shortPath(effect.resource)}</span>
        <span className="muse-eff-sub">
          <span className="muse-origin">{effect.origin === 'auto' ? `🛡 ${t('effect.origin.auto')}` : `📒 ${t('effect.origin.explicit')}`}</span>
          <span>{tx(t, `effect.action.${effect.action}`, effect.action)}</span>
        </span>
      </span>
      <span className="muse-stations" title={t(`effect.status.${effect.status}`)}>
        <i className={fill[0] ? `on-${fill[0]}` : ''} /><i className={fill[1] ? `on-${fill[1]}` : ''} /><i className={fill[2] ? `on-${fill[2]}` : ''} />
      </span>
      <span className={`muse-tag ${effect.status === 'denied' ? 'is-red' : effect.status === 'executed' ? 'is-green' : effect.status === 'executing' ? 'is-blue' : effect.status === 'failed' ? 'is-red' : effect.status === 'rolled_back' ? 'is-dim' : 'is-amber'}`}>
        {effect.status === 'denied' ? '⛔ ' : ''}{t(`effect.status.${effect.status}`)}
      </span>
    </div>
  );
}

function PipelineCard({ effects, t }) {
  return (
    <section className="muse-card">
      <h4>🛡 {t('pipeline.title')}<span className="muse-count">{effects.length}</span></h4>
      {effects.length === 0
        ? <p className="muse-note">{t('pipeline.none')}</p>
        : (
          <div className="muse-lines">
            {effects.map((effect) => <EffectRow key={effect.key} effect={effect} t={t} />)}
          </div>
        )}
    </section>
  );
}

function EvidenceWall({ evidence, t, now }) {
  return (
    <section className="muse-card">
      <h4>📎 {t('evidence.title')}<span className="muse-count">{evidence.length}</span></h4>
      {evidence.length === 0
        ? <p className="muse-note">{t('evidence.none')}</p>
        : (
          <div className="muse-lines">
            {evidence.map((item) => {
              const stale = item.freshUntil != null && item.freshUntil < now;
              return (
                <div key={item.id} className={`muse-evi is-${item.trust === 'trusted' ? 'trusted' : 'untrusted'}`}>
                  <span className="muse-ico">{item.trust === 'trusted' ? '🛡' : '⚠️'}</span>
                  <span className="muse-evi-main">
                    <span className="muse-evi-claim">{item.claim}</span>
                    <span className="muse-evi-sub">
                      <span className={`muse-tag is-${item.trust === 'trusted' ? 'green' : 'amber'}`}>{t(`trust.${item.trust}`)}</span>
                      {item.hash != null && <span className="muse-hash">#{item.hash}</span>}
                      {item.freshUntil != null && <span className={`muse-tag ${stale ? 'is-red' : 'is-green'}`}>{stale ? '⌛' : '🕒'} {stale ? t('fresh.stale') : t('fresh.ok')}</span>}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

function EvalCard({ evaluation, t }) {
  const summary = evaluation?.summary;
  return (
    <section className="muse-card">
      <h4>📊 {t('eval.title')}</h4>
      {summary != null ? (
        <div className="muse-eval">
          <span className="muse-tile"><b>{(100 * (summary.verifiedSuccessRate ?? 0)).toFixed(0)}%</b><span>{t('delivery.eval.verified')}</span></span>
          <span className="muse-tile"><b>{(100 * (summary.duplicateSideEffectRate ?? 0)).toFixed(1)}%</b><span>{t('delivery.eval.duplicates')}</span></span>
          <span className="muse-tile"><b>{formatTokens(summary.totalTokens)}</b><span>{t('delivery.eval.tokens')}</span></span>
        </div>
      ) : (
        <p className="muse-note">{t('delivery.noEval')}</p>
      )}
    </section>
  );
}

function Feed({ activity, t }) {
  const newestFirst = [...activity].reverse();
  return (
    <section className="muse-card muse-feed">
      <h4>📡 {t('feed.title')}<span className="muse-count">{activity.length}</span></h4>
      {newestFirst.length === 0
        ? <p className="muse-note">{t('feed.empty')}</p>
        : (
          <div className="muse-lines">
            {newestFirst.map((row) => (
              <div key={row.seq} className={`muse-feed-row is-${row.kind}${row.status === 'denied' ? ' is-denied' : ''}`}>
                <span className="muse-ico">{row.kind === 'muse' ? '◎' : '✎'}</span>
                <span className="muse-feed-label">{row.label}</span>
                <span className={`muse-tag ${row.status === 'running' ? 'is-blue' : row.status === 'ok' ? 'is-green' : 'is-red'}`}>
                  {row.status === 'running' ? '◐' : row.status === 'ok' ? '✓' : row.status === 'denied' ? '⛔' : '✕'} {t(`feed.status.${row.status}`)}
                </span>
                <span className="muse-loc">T{row.turn}</span>
              </div>
            ))}
          </div>
        )}
    </section>
  );
}

/** The whole technical layer, hidden behind one click by default. */
function TechDetails({ muse, t, now }) {
  const unit = muse.workunit ?? null;
  return (
    <details className="muse-tech">
      <summary>🔧 {t('tech.toggle')}</summary>
      <div className="muse-tech-body">
        <StatPills muse={muse} t={t} />
        <JourneyTechCard unit={unit} t={t} />
        <div className="muse-grid">
          <PipelineCard effects={muse.effects ?? []} t={t} />
          <EvidenceWall evidence={muse.evidence ?? []} t={t} now={now} />
        </div>
        <EvalCard evaluation={muse.eval} t={t} />
        <Feed activity={muse.activity ?? []} t={t} />
      </div>
    </details>
  );
}

/* ------------------------------------------------------------------------ */
/* The view                                                                   */
/* ------------------------------------------------------------------------ */

function MuseView({ useProjection, t }) {
  const muse = useProjection?.('muse');

  /* coarse clock so evidence freshness re-evaluates while mounted */
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  if (muse == null || (muse.seq ?? 0) === 0) {
    return (
      <div className="muse-view">
        <div className="muse-empty">
          <div className="muse-orbit"><i /><i /><i /><b /></div>
          <h3>{t('empty.title')}</h3>
          <p>{t('empty.body')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="muse-view">
      <HeroCard unit={muse.workunit} t={t} />
      <ArtifactsCard unit={muse.workunit} effects={muse.effects} t={t} />
      <LatestRow activity={muse.activity ?? []} t={t} />
      <TechDetails muse={muse} t={t} now={now} />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Session-header progress chip                                               */
/* ------------------------------------------------------------------------ */

const BAR_NOOP_SUB = () => () => {};
const BAR_NO_SNAPSHOT = () => undefined;

/**
 * 会话头部横向进度条（Session log 按钮左侧，conversation.session.header.utilities
 * 槽位）：状态点 + 状态文本 + 步数进度 + 迷你进度条，一行横排。
 * 点击在原位下方弹出悬浮详情卡（状态徽章 / 目标 / 大进度条 / 完整步骤清单 /
 * 「打开工作台」按钮——后者跳到 Muse 工作台标签页并收起悬浮窗）。
 * 点击窗外或再次点击横条收起。会话无 workunit 时不渲染。
 */
function WorkbenchBar({ sessionId, t, sessions }) {
  const face = useMemo(() => {
    const binding = sessions?.binding?.(sessionId);
    return binding?.session?.projections?.faceOf?.('muse') ?? null;
  }, [sessions, sessionId]);
  const [subscribe, getSnapshot] = useMemo(
    () => face === null
      ? [BAR_NOOP_SUB, BAR_NO_SNAPSHOT]
      : [(fn) => face.subscribe(fn), () => face.getSnapshot()],
    [face],
  );
  const muse = useSyncExternalStore(subscribe, getSnapshot);
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (rootRef.current !== null && !rootRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);
  const unit = muse?.workunit ?? null;
  const jump = () => {
    setOpen(false);
    const label = t('view.muse');
    const tab = [...document.querySelectorAll('[role="tab"]')].find((el) => el.textContent.trim() === label);
    tab?.click();
  };

  if (unit == null) {
    return (
      <span className="muse-bar-root" ref={rootRef}>
        <button type="button" className="muse-bar is-standby" onClick={() => setOpen((v) => !v)}
          title={`${t('view.muse')} · ${t('hero.status.none')}`}>
          <i className="muse-bar-dot" />
          <span className="muse-bar-status">{t('hero.status.none')}</span>
        </button>
        {open && (
          <div className="muse-pop">
            <div className="muse-pop-head">
              <span className="muse-pop-title">{t('rail.title')}</span>
              <span className="muse-status is-dim"><i />{t('hero.status.none')}</span>
            </div>
            <p className="muse-pop-obj" style={{ color: 'var(--dsw-alias-label-secondary, #bbb)', fontSize: '11.5px', lineHeight: '1.5' }}>
              {t('rail.standby.tip')}
            </p>
            <button type="button" className="muse-pop-open" onClick={jump}>{t('rail.open')}</button>
          </div>
        )}
      </span>
    );
  }

  const steps = unit.steps ?? [];
  const done = steps.filter((step) => step.status === 'done').length;
  const pct = steps.length > 0
    ? Math.round((done / steps.length) * 100)
    : (unit.status === 'done' ? 100 : 0);
  const tone = statusTone(unit.status);
  return (
    <span className="muse-bar-root" ref={rootRef}>
      <button type="button" className={`muse-bar ${tone}`} onClick={() => setOpen((v) => !v)}
        title={`${t('view.muse')} · ${unit.objective ?? ''}`}>
        <i className="muse-bar-dot" />
        <span className="muse-bar-status">{tx(t, `hero.status.${unit.status}`, unit.status)}</span>
        {steps.length > 0 && <span className="muse-bar-steps">{t('chip.progress', { done, total: steps.length, pct })}</span>}
        <span className="muse-bar-track"><i style={{ width: `${pct}%` }} /></span>
      </button>
      {open && (
        <div className="muse-pop">
          <div className="muse-pop-head">
            <span className="muse-pop-title">{t('rail.title')}</span>
            <span className={`muse-status ${tone}`}><i />{tx(t, `hero.status.${unit.status}`, unit.status)}</span>
          </div>
          <p className="muse-pop-obj">{unit.objective}</p>
          <div className="muse-progress">
            <div className="muse-progress-bar"><i style={{ width: `${pct}%` }} /></div>
            <div className="muse-progress-label">{t('hero.progress', { done, total: steps.length, pct })}</div>
          </div>
          {steps.length > 0 && (
            <ul className="muse-pop-steps">
              {steps.map((step) => (
                <li key={step.id} className={`muse-pop-step ${step.status === 'done' ? 'is-done' : step.status === 'in_progress' ? 'is-run' : (step.status === 'failed' || step.status === 'skipped') ? 'is-bad' : ''}`}>
                  <i /><span>{step.title}</span>
                </li>
              ))}
            </ul>
          )}
          <button type="button" className="muse-pop-open" onClick={jump}>{t('rail.open')}</button>
        </div>
      )}
    </span>
  );
}

/* ------------------------------------------------------------------------ */
/* Plugin body                                                                */
/* ------------------------------------------------------------------------ */

export function apply(ctx) {
  ensureStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-muse-ui: dictionaries');
  const t = ctx.locale.bind(NS);
  ctx.slots.inject('conversation.view', () => ctx.slots.register({
    name: 'conversation.view',
    id: 'muse',
    order: 20,
    locale: NS,
    label: () => t('view.muse'),
    inject: () => ({}),
  }, MuseView));
  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'muse-workbench-bar',
    order: 0,
    locale: NS,
    inject: () => ({ sessions: ctx.sessions }),
  }, WorkbenchBar));
}
