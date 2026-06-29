// explore.mjs <flowId> — 保存済みセッションで指定フローを開き、構造をdumpする。
//   例: node explore.mjs KJW0001100-flow
//   ログイン済みプロファイルを使うので headless でOK。セッション切れなら login.mjs を先に。
import { launch, saveState, ensureSession, ENTRY, DATA_DIR } from './lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const flowId = process.argv[2];
if (!flowId) { console.error('使い方: node explore.mjs <flowId>'); process.exit(1); }

const { browser, context, page } = await launch({ headless: true });

if (!(await ensureSession(page))) {
  console.error('✗ セッション切れ。先に `node login.mjs` を実行してください。');
  await browser.close();
  process.exit(2);
}

// フロー起動
const url = `${ENTRY}campussquare.do?_flowId=${flowId}`;
await page.goto(url, { waitUntil: 'domcontentloaded' });
try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}

const info = {
  flowId,
  url: page.url(),
  title: await page.title(),
  // 見出し・本文の手がかり
  headings: await page.$$eval('h1,h2,h3,caption,legend,th', els =>
    [...new Set(els.map(e => (e.textContent || '').trim().replace(/\s+/g, ' ')).filter(Boolean))].slice(0, 60)),
  // 操作系
  forms: await page.$$eval('form', fs => fs.map(f => ({ action: f.action, method: f.method, id: f.id, name: f.name }))),
  selects: await page.$$eval('select', ss => ss.map(s => ({ name: s.name, id: s.id, options: [...s.options].map(o => o.text.trim()).slice(0, 20) }))),
  links: await page.$$eval('a', as => as.map(a => ({
    text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70),
    href: a.href, onclick: a.getAttribute('onclick')?.slice(0, 140) || null,
  })).filter(l => (l.text || l.onclick) && !/javascript:void\(0\);?$/.test(l.href + (l.onclick || 'x'))).slice(0, 120)),
  tableCount: await page.$$eval('table', t => t.length),
};

const outDir = path.join(DATA_DIR, 'inspect');
await fs.mkdir(outDir, { recursive: true });
const base = path.join(outDir, flowId);
await fs.writeFile(base + '.json', JSON.stringify(info, null, 2));
await fs.writeFile(base + '.html', await page.content());
await page.screenshot({ path: base + '.png', fullPage: true });
console.log('✓ saved', base + '.{json,html,png}');
console.log('title:', info.title, '| tables:', info.tableCount, '| selects:', info.selects.length, '| links:', info.links.length);

await saveState(context);
await browser.close();
