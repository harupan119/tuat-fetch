// classroom/fetch.mjs — Google Classroom の未提出課題を取得。
//   not-turned-in ページをスクレイプ。保存セッション(classroom_state.json)を使う。
//   出力: ~/.local/share/sirius-fetch/output/classroom-todo.{md,json}
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const STATE = path.join(os.homedir(), '.local/share/sirius-fetch/classroom_state.json');
const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');
if (!fs.existsSync(STATE)) { console.error('✗ 未ログイン。先に `node classroom/login.mjs`'); process.exit(1); }

let browser; try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); } catch { browser = await chromium.launch({ headless: true }); }
const ctx = await browser.newContext({ storageState: STATE });
const page = await ctx.newPage();
await page.goto('https://classroom.google.com/u/0/a/not-turned-in/all', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
if (/accounts\.google|ServiceLogin|signin/i.test(page.url())) { console.error('✗ セッション切れ。`node classroom/login.mjs` で再ログインを。'); await browser.close(); process.exit(2); }

const raw = await page.evaluate(() => {
  const main = document.querySelector('[role=main]') || document.body;
  const links = [...main.querySelectorAll('a[href*="/a/"][href*="/details"]')];
  const seen = new Set(); const out = [];
  for (const a of links) {
    const href = a.getAttribute('href');
    if (seen.has(href)) continue; seen.add(href);
    // 末端要素のテキストを順に（title / course / due が別span）
    const parts = [...a.querySelectorAll('*')].filter((e) => e.children.length === 0).map((e) => e.textContent.trim()).filter(Boolean);
    out.push({ href, parts, all: (a.textContent || '').replace(/\s+/g, ' ').trim() });
  }
  return out;
});

const DUE_RE = /(今日|明日|昨日|\d{1,2}月\d{1,2}日|[月火水木金土日]曜日|\d{1,2}:\d{2})/;
const items = raw
  .filter((r) => !/投稿:/.test(r.all))   // 「投稿:」=締切なしの古い資料系を除外
  .map(({ href, parts }) => {
    const body = parts.filter((l) => !/^(assignment|material|question|課題|資料|質問|割り当て済み|未提出|完了)$/i.test(l));
    const dues = body.filter((l) => DUE_RE.test(l));
    const nonDue = body.filter((l) => !DUE_RE.test(l));
    return { title: nonDue[0] || body[0] || '(無題)', course: nonDue[1] || '', due: dues[0] || '', href: 'https://classroom.google.com' + href };
  });

await browser.close();

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'classroom.json'), JSON.stringify(items, null, 2));
const lines = [`# Classroom 未提出課題  (${new Date().toLocaleString('ja-JP')})`, '', `未提出: ${items.length}件`, ''];
for (const t of items) lines.push(`- [ ] **${t.title}**（${t.course}）〆${t.due || '?'}\n      ${t.href}`);
fs.writeFileSync(path.join(OUT, 'classroom-todo.md'), lines.join('\n') + '\n');

console.log(`✓ Classroom未提出 ${items.length}件 → ${OUT}/classroom-todo.md`);
for (const t of items) console.log(`  ・${t.title}（${t.course}）〆${t.due || '?'}`);

if (items.length) execFile('osascript', ['-e', `display notification "${items.slice(0,5).map(t=>t.title).join(', ').replace(/"/g,"'")}" with title "Classroom未提出 ${items.length}件" sound name "Glass"`]);
