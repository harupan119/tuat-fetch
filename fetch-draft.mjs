// fetch-draft.mjs — Sakai課題の「要件(指示文)」と提出ドラフト添付を取得する（閲覧用）。
//   使い方: node fetch-draft.mjs "<assignmentReference or 提出ページURL>" "<課題タイトルの一部>" "<科目の一部>"
import { getSession, openSakai, saveState, LMS } from './lib.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const submitUrl = process.argv[2];
const titleQ = process.argv[3] || '';
const courseQ = process.argv[4] || '';
const SCRATCH = process.argv[5] || '/tmp';

const { browser, context, page } = await getSession();
if (!(await openSakai(page))) { console.error('✗ Sakaiに入れません'); await browser.close(); process.exit(1); }
const j = async (p) => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

// --- 要件(指示文)をRESTから ---
const sj = await j('/direct/site.json?_limit=999');
let sites = (sj?.site_collection || []).map((s) => ({ id: s.id, title: s.title })).filter((s) => /^\d{4}_\d{2}/.test(s.id));
const curTerm = sites.map((s) => s.id.slice(0, 7)).sort().reverse()[0];
sites = sites.filter((s) => s.id.startsWith(curTerm) && (!courseQ || s.title.includes(courseQ)));
let asg = null;
for (const s of sites) {
  const a = await j(`/direct/assignment/site/${s.id}.json?_limit=999`);
  for (const x of a?.assignment_collection || []) if (!titleQ || (x.title || '').includes(titleQ)) { asg = x; break; }
  if (asg) break;
}
if (asg) {
  console.log('■ 課題:', asg.title);
  console.log('■ 締切:', asg.dueTimeString || asg.dueTime?.display || '');
  const instr = String(asg.instructions || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  console.log('■ 要件(指示文):\n', instr || '(指示文なし)');
} else { console.log('⚠ REST で課題が見つからず（指示文は提出ページ側で確認）'); }

// --- 提出ページからドラフト添付をダウンロード ---
await page.goto(submitUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
await page.waitForTimeout(4000);
const links = await page.evaluate(() => {
  const grab = (doc) => [...doc.querySelectorAll('a[href]')]
    .map((a) => ({ href: a.href, text: (a.textContent || '').replace(/\s+/g, ' ').trim() }))
    .filter((l) => /\/access\/content\//.test(l.href));
  let out = grab(document);
  for (const f of document.querySelectorAll('iframe')) { try { out = out.concat(grab(f.contentDocument)); } catch {} }
  // 重複除去
  const seen = new Set(); return out.filter((l) => !seen.has(l.href) && seen.add(l.href));
});
console.log(`\n■ 提出ページの添付候補: ${links.length}件`);
const saved = [];
for (const l of links) {
  if (!/\.(pdf|docx?|txt)(\?|$)/i.test(l.href)) { console.log('  (スキップ非文書)', l.text || l.href.slice(-40)); continue; }
  const r = await context.request.get(l.href);
  if (!r.ok()) { console.log('  ✗ DL失敗', l.text); continue; }
  const buf = Buffer.from(await r.body());
  const name = (l.text && /\.[a-z0-9]{2,5}$/i.test(l.text)) ? l.text : decodeURIComponent(l.href.split('/').pop().split('?')[0]);
  const dest = path.join(SCRATCH, name);
  await fs.writeFile(dest, buf);
  saved.push(dest);
  console.log(`  ✓ ${name} (${(buf.length / 1024).toFixed(0)}KB) → ${dest}`);
}

await saveState(context);
await browser.close();
console.log('\nSAVED:', JSON.stringify(saved));
