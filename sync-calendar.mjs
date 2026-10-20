#!/usr/bin/env node
// sync-calendar.mjs — 未提出課題を Google Calendar（大学）に同期
//   元データ: ~/.local/share/sirius-fetch/output/{assignments.json, classroom.json}
//   台帳: ~/.local/share/sirius-fetch/calendar-synced.json
//
//   node sync-calendar.mjs              未同期の課題を一覧表示
//   node sync-calendar.mjs --sync       Google Calendar API で直接登録（OAuth必要）
//   node sync-calendar.mjs --json       未同期の課題をJSON出力（Claude Code MCP連携用）
//   node sync-calendar.mjs --mark KEY   同期済みとして台帳に記録
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const DATA = path.join(os.homedir(), '.local/share/sirius-fetch');
const OUT = path.join(DATA, 'output');
const LEDGER = path.join(DATA, 'calendar-synced.json');

// 同期先カレンダーのID（Google カレンダーの設定 →「カレンダーの統合」に出る ID）。未指定ならメインのカレンダー
export const CAL_ID = process.env.SIRIUS_GCAL_ID || 'primary';

// 課題扱いしない見出し。環境変数 SIRIUS_IGNORE_KEYWORDS にカンマ区切りで指定（reminder-daily.mjs と共通）
const IGNORE = (process.env.SIRIUS_IGNORE_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean);

function loadLedger() {
  try { return JSON.parse(fs.readFileSync(LEDGER, 'utf8')); } catch { return {}; }
}
function saveLedger(data) {
  fs.writeFileSync(LEDGER, JSON.stringify(data, null, 2));
}

const WEEKDAYS = '日月火水木金土';

function parseJaDate(text) {
  if (!text) return null;
  const md = text.match(/(\d{1,2})月(\d{1,2})日/);
  if (md) {
    const y = new Date().getFullYear();
    return `${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }
  const wd = text.match(/(月|火|水|木|金|土|日)曜日/);
  if (wd) {
    const target = WEEKDAYS.indexOf(wd[1]);
    const today = new Date();
    const curr = today.getDay();
    let diff = target - curr;
    if (diff < 0) diff += 7;
    const d = new Date(today);
    d.setDate(d.getDate() + diff);
    return d.toLocaleDateString('sv-SE');
  }
  if (/今日/.test(text)) return new Date().toLocaleDateString('sv-SE');
  if (/明日/.test(text)) { const d = new Date(); d.setDate(d.getDate() + 1); return d.toLocaleDateString('sv-SE'); }
  return null;
}

function nextDay(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + 1);
  return d.toLocaleDateString('sv-SE');
}

function sakaiDueToJST(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

const cleanCourse = (t) => (t || '').replace(/^\['?\d+[^\]]*\]/, '').trim();

// --- CLI ---
const args = process.argv.slice(2);

if (args[0] === '--mark') {
  const keys = args.slice(1);
  if (!keys.length) { console.error('使い方: --mark KEY [KEY ...]'); process.exit(1); }
  const ledger = loadLedger();
  for (const key of keys) {
    ledger[key] = { syncedAt: new Date().toISOString() };
    console.log(`✓ ${key}`);
  }
  saveLedger(ledger);
  process.exit(0);
}

const sakai = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'assignments.json'), 'utf8')); } catch { return []; } })();
const classroom = (() => { try { return JSON.parse(fs.readFileSync(path.join(OUT, 'classroom.json'), 'utf8')); } catch { return []; } })();
const ledger = loadLedger();
const events = [];

for (const a of sakai) {
  const course = cleanCourse(a.course);
  const key = `sakai:${course}:${a.title}`;
  if (ledger[key]) continue;
  if (IGNORE.some((kw) => a.title.includes(kw))) continue;
  const date = sakaiDueToJST(a.due);
  if (!date) continue;
  events.push({
    key,
    summary: `${a.title}（${course}）`,
    date,
    endDate: nextDay(date),
    description: `大学 (課題)\n-------\nsirius-fetch auto-sync\nsource: Sakai`,
    source: 'Sakai',
  });
}

for (const a of classroom) {
  const key = `classroom:${a.course}:${a.title}`;
  if (ledger[key]) continue;
  if (IGNORE.some((kw) => a.title.includes(kw))) continue;
  const date = parseJaDate(a.due);
  if (!date) continue;
  events.push({
    key,
    summary: `${a.title}（${a.course}）`,
    date,
    endDate: nextDay(date),
    description: `大学 (課題)\n-------\nsirius-fetch auto-sync\nsource: Classroom${a.href ? '\n' + a.href : ''}`,
    source: 'Classroom',
    url: a.href || null,
  });
}

if (args[0] === '--sync') {
  if (!events.length) { console.log(`✓ 新規同期対象なし（台帳: ${Object.keys(ledger).length}件登録済み）`); process.exit(0); }
  const { getCalendarClient, createAllDayEvent } = await import('./lib-gcal.mjs');
  const cal = getCalendarClient();
  if (!cal) { console.error('✗ OAuth未設定。先に node google-auth.mjs を実行してください。'); process.exit(1); }
  console.log(`▶ ${events.length}件を登録中...`);
  let ok = 0;
  for (const e of events) {
    try {
      await createAllDayEvent(cal, { calendarId: CAL_ID, summary: e.summary, date: e.date, endDate: e.endDate, description: e.description });
      ledger[e.key] = { syncedAt: new Date().toISOString() };
      ok++;
      console.log(`  ✓ ${e.summary} → ${e.date}`);
    } catch (err) {
      console.error(`  ✗ ${e.summary}: ${err.message}`);
      // refresh token 失効は全件同じ理由で落ちるので、残りは試さず抜ける
      if (/invalid_grant/.test(err.message)) { console.error('  → カレンダーの認証切れ。手動で `node google-auth.mjs`'); break; }
    }
  }
  saveLedger(ledger);
  console.log(`${ok === events.length ? '✓' : '✗'} ${ok}/${events.length}件 登録完了`);
  if (ok < events.length) process.exit(1);
} else if (args[0] === '--json') {
  console.log(JSON.stringify(events, null, 2));
} else {
  if (!events.length) {
    console.log(`✓ 新規同期対象なし（台帳: ${Object.keys(ledger).length}件登録済み）`);
  } else {
    console.log(`▶ 未同期 ${events.length}件:`);
    for (const e of events) console.log(`  ・${e.summary} → ${e.date} [${e.source}]`);
    console.log(`\n--sync で直接登録。--json でJSON出力（MCP用）。`);
  }
}
