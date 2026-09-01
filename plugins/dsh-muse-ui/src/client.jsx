/**
 * dsh-muse-ui — browser half: the Muse 工作台 conversation view tab.
 *
 * Registers one entry in the `conversation.view` list slot (order 20, right
 * of the trajectory tab) and renders the live `muse` session projection
 * pushed by dsh-muse-bridge as a graphical board: a task-journey milestone
 * track with step dots and budget gauges, an effect pipeline with per-entry
 * station tracks, an evidence wall, a delivery seal and a live activity
 * timeline. All graphics are hand-rolled CSS/SVG — no chart library, no
 * externals beyond the browser module-table baseline (react).
 *
 * @module dsh-muse-ui/client
 */
import { useEffect, useState } from 'react';
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
/* header stat pills */
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
/* cards */
.muse-card { border: 1px solid var(--dsw-alias-border-l2, #303030); border-radius: 12px; background: var(--dsw-alias-bg-layer-1, #1d1d1d); padding: 12px 14px; }
.muse-card h4 { margin: 0 0 10px; font-size: 11px; font-weight: 600; letter-spacing: .05em; text-transform: uppercase; color: var(--dsw-alias-label-caption, #8a8a8a); display: flex; align-items: center; gap: 7px; }
.muse-card h4 .muse-count { margin-left: auto; font-weight: 400; text-transform: none; letter-spacing: 0; color: var(--dsw-alias-label-dimmed, #777); }
.muse-grid { display: grid; grid-template-columns: 1.15fr 1fr; gap: 12px; }
@media (max-width: 900px) { .muse-grid { grid-template-columns: 1fr; } }
/* journey milestones */
.muse-track { position: relative; display: flex; justify-content: space-between; margin: 6px 10px 2px; }
.muse-track::before { content: ""; position: absolute; top: 13px; left: 24px; right: 24px; height: 3px; border-radius: 2px; background: var(--dsw-alias-bg-layer-2, #2c2c2c); }
.muse-track .muse-fill { position: absolute; top: 13px; left: 24px; height: 3px; border-radius: 2px; background: var(--dsw-alias-state-success-primary, #5cb85c); transition: width .5s ease; max-width: calc(100% - 48px); }
.muse-track.is-warn .muse-fill { background: var(--dsw-alias-state-warn-label, #d90); }
.muse-track.is-fail .muse-fill { background: var(--dsw-alias-state-error-primary, #f66); }
.muse-mile { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; gap: 6px; width: 72px; }
.muse-mile .muse-dot { width: 27px; height: 27px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 13px; background: var(--dsw-alias-bg-layer-2, #2c2c2c); border: 2px solid transparent; color: var(--dsw-alias-label-dimmed, #666); }
.muse-mile.is-reached .muse-dot { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 22%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-mile.is-current .muse-dot { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 26%, var(--dsw-alias-bg-layer-2, #222)); color: #fff; border-color: var(--dsw-alias-state-business-primary, #4a7dff); animation: muse-pulse 1.8s ease infinite; color: var(--dsw-alias-state-business-primary, #4a7dff); }
.muse-track.is-warn .muse-mile.is-current .muse-dot { border-color: var(--dsw-alias-state-warn-label, #d90); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 26%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-warn-label, #d90); }
.muse-track.is-fail .muse-mile.is-current .muse-dot { border-color: var(--dsw-alias-state-error-primary, #f66); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 26%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-error-primary, #f66); animation: none; }
.muse-mile span { font-size: 11px; color: var(--dsw-alias-label-tertiary, #8f8f8f); }
.muse-mile.is-reached span, .muse-mile.is-current span { color: var(--dsw-alias-label-primary, #eee); font-weight: 600; }
/* alert banner */
.muse-alert { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding: 6px 12px; border-radius: 8px; font-weight: 600; animation: muse-breathe 2.2s ease infinite; }
.muse-alert.is-warn { color: var(--dsw-alias-state-warn-label, #d90); background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 12%, transparent); }
.muse-alert.is-fail { color: var(--dsw-alias-state-error-primary, #f66); background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 12%, transparent); animation: none; }
/* objective */
.muse-objective { margin: 10px 0 0; line-height: 1.55; }
.muse-objective .muse-k { color: var(--dsw-alias-label-caption, #8a8a8a); margin-right: 6px; }
.muse-note { color: var(--dsw-alias-label-dimmed, #888); font-size: 11.5px; line-height: 1.5; }
/* steps chain */
.muse-steps { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 0; margin-top: 4px; }
.muse-stepdot { display: flex; flex-direction: column; align-items: center; gap: 4px; width: 52px; }
.muse-stepdot i { width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 11px; font-style: normal; background: var(--dsw-alias-bg-layer-2, #2c2c2c); color: var(--dsw-alias-label-dimmed, #666); }
.muse-stepdot.is-done i { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 22%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-success-primary, #5cb85c); }
.muse-stepdot.is-in_progress i { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 30%, var(--dsw-alias-bg-layer-2, #222)); color: #fff; animation: muse-pulse 1.8s ease infinite; }
.muse-stepdot.is-failed i { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 24%, var(--dsw-alias-bg-layer-2, #222)); color: var(--dsw-alias-state-error-primary, #f66); }
.muse-stepdot.is-skipped i { opacity: .45; text-decoration: line-through; }
.muse-stepdot em { font-style: normal; font-size: 10px; color: var(--dsw-alias-label-dimmed, #777); max-width: 52px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: center; }
.muse-step-link { width: 18px; height: 2px; margin-bottom: 16px; background: var(--dsw-alias-bg-layer-2, #333); flex: none; }
/* budget gauges */
.muse-budget { display: flex; align-items: center; gap: 18px; margin-top: 12px; padding-top: 10px; border-top: 1px dashed var(--dsw-alias-border-l2, #303030); }
.muse-gauge { display: flex; align-items: center; gap: 9px; }
.muse-gauge svg { display: block; }
.muse-gauge .muse-gauge-text { display: flex; flex-direction: column; gap: 1px; }
.muse-gauge .muse-gauge-text b { font-size: 12px; font-variant-numeric: tabular-nums; }
.muse-gauge .muse-gauge-text span { font-size: 10.5px; color: var(--dsw-alias-label-dimmed, #888); }
.muse-gauge.is-warn circle.val { stroke: var(--dsw-alias-state-warn-label, #d90); }
.muse-gauge.is-over circle.val { stroke: var(--dsw-alias-state-error-primary, #f66); }
/* pipeline entries */
.muse-lines { display: flex; flex-direction: column; gap: 7px; }
.muse-eff { display: flex; align-items: center; gap: 9px; padding: 6px 8px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2, #232323); }
.muse-eff.is-denied { background: color-mix(in srgb, var(--dsw-alias-state-error-primary, #f66) 10%, var(--dsw-alias-bg-layer-2, #232323)); }
.muse-eff .muse-ico { width: 26px; height: 26px; border-radius: 8px; flex: none; display: flex; align-items: center; justify-content: center; font-size: 13px; background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 15%, transparent); }
.muse-eff .muse-eff-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.muse-eff .muse-eff-path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; }
.muse-eff .muse-eff-sub { display: flex; gap: 6px; align-items: center; font-size: 10px; color: var(--dsw-alias-label-dimmed, #777); }
.muse-eff .muse-eff-sub .muse-origin { border: 1px solid var(--dsw-alias-border-l2, #363636); border-radius: 6px; padding: 0 5px; }
/* station mini-track */
.muse-stations { position: relative; display: flex; gap: 10px; align-items: center; flex: none; }
.muse-stations i { width: 9px; height: 9px; border-radius: 50%; background: var(--dsw-alias-bg-layer-1, #3a3a3a); border: 1px solid var(--dsw-alias-border-l2, #444); }
.muse-stations i.on-amber { background: var(--dsw-alias-state-warn-label, #d90); border-color: transparent; }
.muse-stations i.on-green { background: var(--dsw-alias-state-success-primary, #5cb85c); border-color: transparent; }
.muse-stations i.on-blue { background: var(--dsw-alias-state-business-primary, #4a7dff); border-color: transparent; animation: muse-breathe 1.4s ease infinite; }
.muse-stations i.on-red { background: var(--dsw-alias-state-error-primary, #f66); border-color: transparent; }
/* evidence wall */
.muse-evi { display: flex; gap: 9px; align-items: flex-start; padding: 7px 9px; border-radius: 9px; background: var(--dsw-alias-bg-layer-2, #232323); }
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
.muse-tag.is-dim { color: var(--dsw-alias-label-dimmed, #888); background: var(--dsw-alias-bg-layer-1, #2a2a2a); }
.muse-hash { font-family: ui-monospace, monospace; font-size: 9.5px; color: var(--dsw-alias-label-dimmed, #666); }
/* delivery seal */
.muse-delivery { display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.muse-seal { width: 54px; height: 54px; border-radius: 50%; flex: none; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 22px; }
.muse-seal.is-ok { background: color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 16%, transparent); color: var(--dsw-alias-state-success-primary, #5cb85c); box-shadow: 0 0 0 4px color-mix(in srgb, var(--dsw-alias-state-success-primary, #5cb85c) 8%, transparent); }
.muse-seal.is-wait { background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 14%, transparent); color: var(--dsw-alias-state-warn-label, #d90); }
.muse-seal small { font-size: 8.5px; font-weight: 600; letter-spacing: .03em; }
.muse-deliver-right { display: flex; flex-direction: column; gap: 6px; min-width: 0; flex: 1; }
.muse-artifacts { display: flex; flex-wrap: wrap; gap: 6px; }
.muse-artifact { display: flex; gap: 5px; align-items: center; padding: 3px 9px; border-radius: 7px; background: var(--dsw-alias-bg-layer-2, #232323); font-family: ui-monospace, monospace; font-size: 10.5px; }
.muse-eval { display: flex; gap: 8px; flex-wrap: wrap; }
.muse-tile { display: flex; flex-direction: column; gap: 1px; padding: 5px 11px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #232323); }
.muse-tile b { font-size: 13px; font-variant-numeric: tabular-nums; }
.muse-tile span { font-size: 10px; color: var(--dsw-alias-label-dimmed, #888); }
/* feed timeline */
.muse-feed { flex: 1; min-height: 110px; display: flex; flex-direction: column; }
.muse-feed .muse-lines { flex: 1; overflow-y: auto; gap: 5px; }
.muse-feed-row { display: flex; gap: 9px; align-items: center; min-width: 0; }
.muse-feed-row .muse-ico { width: 22px; height: 22px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; font-size: 10.5px; }
.muse-feed-row.is-muse .muse-ico { background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #4a7dff) 17%, transparent); }
.muse-feed-row.is-write .muse-ico { background: color-mix(in srgb, var(--dsw-alias-state-warn-label, #d90) 17%, transparent); }
.muse-feed-row .muse-feed-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11.5px; color: var(--dsw-alias-label-secondary, #bbb); }
.muse-feed-row.is-denied .muse-feed-label { color: var(--dsw-alias-state-error-primary, #f66); }
.muse-feed-row .muse-loc { flex: none; font-size: 9.5px; color: var(--dsw-alias-label-dimmed, #5f5f5f); font-variant-numeric: tabular-nums; }
/* empty state */
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
/* Sections                                                                   */
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

function JourneyCard({ unit, t }) {
  if (unit == null) {
    return (
      <section className="muse-card">
        <h4>🧭 {t('journey.title')}</h4>
        <p className="muse-note">{t('journey.none')}</p>
      </section>
    );
  }
  const hasVerification = unit.verification != null;
  const trip = journey(unit.status, hasVerification);
  const milestones = ['draft', 'active', 'verify', 'done'];
  const fillPercent = trip.current === null ? 100 : (trip.current / (milestones.length - 1)) * 100;
  const budget = unit.budget ?? {};
  const tokenRatio = budget.maxTokens ? (budget.spentTokens ?? 0) / budget.maxTokens : 0;
  const failureRatio = budget.maxFailures ? (budget.failures ?? 0) / budget.maxFailures : 0;
  const roundRatio = budget.maxRounds ? (budget.roundsUsed ?? 0) / budget.maxRounds : 0;
  const alertKey = trip.tone === 'warn' ? `journey.alert.${unit.status}` : trip.tone === 'fail' ? `journey.${unit.status}` : null;
  const steps = unit.steps ?? [];

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
      {alertKey != null && (
        <div className={`muse-alert is-${trip.tone === 'warn' ? 'warn' : 'fail'}`}>
          {trip.tone === 'warn' ? '⏳' : '⛔'} {t(alertKey)}
        </div>
      )}
      <p className="muse-objective"><span className="muse-k">📌 {t('journey.objective')}</span>{unit.objective ?? '—'}</p>
      {(unit.constraints?.length ?? 0) > 0 && (
        <p className="muse-note">📎 {t('journey.constraints')}: {unit.constraints.join(' · ')}</p>
      )}
      {steps.length > 0 && (
        <div className="muse-steps">
          {steps.map((step, index) => (
            <span key={step.id} style={{ display: 'contents' }}>
              {index > 0 && <span className="muse-step-link" />}
              <span className={`muse-stepdot is-${step.status}`} title={`${step.title}${step.note ? ` — ${step.note}` : ''}`}>
                <i>{STEP_ICON[step.status] ?? '·'}</i>
                <em>{step.title}</em>
              </span>
            </span>
          ))}
        </div>
      )}
      <div className="muse-budget">
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

function DeliveryCard({ unit, evaluation, t }) {
  const verified = unit?.verification != null;
  const summary = evaluation?.summary;
  return (
    <section className="muse-card">
      <h4>📦 {t('delivery.title')}</h4>
      <div className="muse-delivery">
        <div className={`muse-seal ${verified ? 'is-ok' : 'is-wait'}`}>
          {verified ? '✓' : '？'}
          <small>{verified ? t('delivery.verified') : t('delivery.unverified')}</small>
        </div>
        <div className="muse-deliver-right">
          {(unit?.artifacts ?? []).length > 0 && (
            <div className="muse-artifacts">
              {unit.artifacts.map((artifact) => (
                <span key={artifact.id ?? artifact.path} className="muse-artifact" title={artifact.path}>
                  📄 {shortPath(artifact.path)} {verified ? '✓' : '…'}
                </span>
              ))}
            </div>
          )}
          {summary != null ? (
            <div className="muse-eval">
              <span className="muse-tile"><b>{(100 * (summary.verifiedSuccessRate ?? 0)).toFixed(0)}%</b><span>{t('delivery.eval.verified')}</span></span>
              <span className="muse-tile"><b>{(100 * (summary.duplicateSideEffectRate ?? 0)).toFixed(1)}%</b><span>{t('delivery.eval.duplicates')}</span></span>
              <span className="muse-tile"><b>{formatTokens(summary.totalTokens)}</b><span>{t('delivery.eval.tokens')}</span></span>
            </div>
          ) : (
            <p className="muse-note">{t('delivery.noEval')}</p>
          )}
        </div>
      </div>
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
      <StatPills muse={muse} t={t} />
      <JourneyCard unit={muse.workunit} t={t} />
      <div className="muse-grid">
        <PipelineCard effects={muse.effects ?? []} t={t} />
        <EvidenceWall evidence={muse.evidence ?? []} t={t} now={now} />
      </div>
      <DeliveryCard unit={muse.workunit} evaluation={muse.eval} t={t} />
      <Feed activity={muse.activity ?? []} t={t} />
    </div>
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
}
