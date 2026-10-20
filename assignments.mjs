// assignments.mjs — Sakaiの未提出課題アラート。
//   各課題ツール画面の「状態」列をスクレイプ:「提出日時 …」=提出済 / それ以外=未提出。
//   今学期(最新の YYYY_TT)のサイトを対象に、未提出を締切順に出力＋近い/超過はmacOS通知。
//   出力: ~/.local/share/sirius-fetch/output/assignments.json と assignments-todo.md
import { getSession, openSakai, saveState, LMS, DATA_DIR, sitesWithAssignments, readAssignmentRows } from './lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { notify } from './platform.mjs';

const OUT = path.join(DATA_DIR, 'output');
const api = (context) => async (p) => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

// 「状態」テキストから提出済みか判定
const isSubmitted = (st) => /提出日時|提出済|採点済|返却|graded|returned|submitted/i.test(st || '');
// JST表記 "2026/06/25 12:00" → Date
const parseJST = (s) => { const m = (s || '').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})/); return m ? new Date(`${m[1]}-${String(m[2]).padStart(2,'0')}-${String(m[3]).padStart(2,'0')}T${String(m[4]).padStart(2,'0')}:${m[5]}:00+09:00`) : null; };

const { browser, context, page } = await getSession();
if (!(await openSakai(page))) { console.error('✗ Sakaiに入れません。'); await browser.close(); process.exit(1); }
const j = api(context);

// 全サイト→最新学期(YYYY_TT最大)を今学期とみなす
const sj = await j('/direct/site.json?_limit=999');
const allSites = (sj?.site_collection || []).map((s) => ({ id: s.id, title: s.title })).filter((s) => /^\d{4}_\d{2}/.test(s.id));
const curTerm = allSites.map((s) => s.id.slice(0, 7)).sort().reverse()[0];
const sites = allSites.filter((s) => s.id.startsWith(curTerm));
console.log(`▶ 今学期 ${curTerm} のサイト ${sites.length}件 を走査`);

// 課題を持つサイトだけに絞る（APIは並列）
const targets = await sitesWithAssignments(context, sites);

const todo = [];
for (const site of targets) {
  // 一覧の読み取りは lib.mjs に集約（placementの選び方・待ち方の理由はそちらのコメント参照）
  for (const r of await readAssignmentRows(page, context, site.id)) {
    const title = r.cells[0], status = r.cells[1], due = parseJST(r.cells[r.cells.length - 1]);
    if (!title || isSubmitted(status)) continue;       // 提出済は除外
    todo.push({ course: site.title, title, status, due: due ? due.toISOString() : null });
  }
}

await saveState(context);
await browser.close();

const now = Date.now();
todo.sort((a, b) => (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity));
const fmt = (iso) => iso ? new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '締切なし';
const cleanCourse = (t) => (t || '').replace(/^\['?\d+[^\]]*\]/, '').trim();

const lines = [`# Sakai 未提出課題  (${new Date().toLocaleString('ja-JP')})`, '', `今学期 ${curTerm} / 未提出 ${todo.length}件`, ''];
for (const t of todo) {
  const od = t.due && Date.parse(t.due) < now ? ' ⚠️超過' : '';
  lines.push(`- [ ] **${t.title}**（${cleanCourse(t.course)}）〆${fmt(t.due)}${od}  _${t.status}_`);
}
await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'assignments.json'), JSON.stringify(todo, null, 2));
await fs.writeFile(path.join(OUT, 'assignments-todo.md'), lines.join('\n') + '\n');

console.log(`✓ 未提出 ${todo.length}件 → ${OUT}/assignments-todo.md`);
for (const t of todo) console.log(`  ・${t.title}（${cleanCourse(t.course)}）〆${fmt(t.due)}${t.due && Date.parse(t.due) < now ? ' ⚠️超過' : ''}`);

const soon = todo.filter((t) => t.due && Date.parse(t.due) < now + 7 * 864e5);
if (soon.length) {
  const msg = soon.slice(0, 6).map((t) => `${t.title}(${fmt(t.due)})`).join(', ');
  notify({ title: `未提出課題 ${soon.length}件`, message: msg });
}
