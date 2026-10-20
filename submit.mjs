// submit.mjs — Sakai(SIRIUS-LMS)課題にファイルを添付してドラフト保存し、提出画面を開く。
//   最終の「提出(Proceed)」ボタンは絶対に押さない（本人が押す）。
//
//   使い方:
//     node submit.mjs --title "<課題タイトルの一部>" --file "<提出ファイルの絶対パス>" [--course "<科目名の一部>"]
//     node submit.mjs --url "<提出ページURL>" --file "<絶対パス>"
//   オプション:
//     --save-only   ドラフト保存だけで終了（提出画面を開いたままにしない / headless）
//     --dry-run     提出ページURLを特定するだけで終了（添付もドラフト保存もしない。--file 不要）
//   例:
//     node submit.mjs --title "第10回課題" --file ~/Projects/TUAT/<科目>/10_work/10_<学籍番号>.c
import { launch, openSakai, saveState, LMS, assignmentPlacements, assignmentListUrl } from './lib.mjs';
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); const v = i >= 0 ? args[i + 1] : null; return v && !v.startsWith('--') ? v : null; };
const titleQ = opt('--title') || '';
const courseQ = opt('--course') || '';
const file = opt('--file');
let url = opt('--url');
const saveOnly = args.includes('--save-only');
const dryRun = args.includes('--dry-run');   // URL特定だけして終了（安全に動作確認するため）

if (!dryRun && (!file || !fs.existsSync(file))) { console.error('✗ --file <提出ファイルの絶対パス> が必要（存在しません）'); process.exit(1); }
if (!url && !titleQ) { console.error('✗ --title か --url のどちらかが必要'); process.exit(1); }
const base = file ? path.basename(file) : '';   // Windows の \ 区切りでも取れるように

// --save-only は headless、それ以外は提出画面を開いたままにするため headed
const { browser, context, page } = await launch({ headless: saveOnly || dryRun });
if (!(await openSakai(page))) { console.error('✗ Sakaiに入れません（sirius-session で再ログイン）'); await browser.close(); process.exit(1); }

const j = async (p) => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

// ── 提出ページURLの特定（--url 未指定時。find-assignment.mjs と同ロジック） ──
if (!url) {
  const sj = await j('/direct/site.json?_limit=999');
  let sites = (sj?.site_collection || []).map((s) => ({ id: s.id, title: s.title })).filter((s) => /^\d{4}_\d{2}/.test(s.id));
  const curTerm = sites.map((s) => s.id.slice(0, 7)).sort().reverse()[0];
  sites = sites.filter((s) => s.id.startsWith(curTerm));
  if (courseQ) sites = sites.filter((s) => s.title.includes(courseQ));
  console.log(`▶ 対象サイト候補: ${sites.map((s) => s.title).join(' / ') || '(なし)'}`);
  // ⚠️ 課題一覧は必ず assignmentListUrl 経由で開く（理由は lib.mjs のコメント）。
  //    ページURLだと前回の提出画面が貼り付いたままになり、そこに --title と部分一致する
  //    リンクがあると別の課題の提出ページに添付してしまう危険がある。
  outer:
  for (const site of sites) {
    for (const tid of await assignmentPlacements(context, site.id)) {
      await page.goto(assignmentListUrl(tid), { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForTimeout(4000);
      let href = null;
      for (let attempt = 0; attempt < 3 && !href; attempt++) {
        href = await page.evaluate((q) => {
          const scan = (doc) => { for (const a of doc.querySelectorAll('a[href]')) { const t = (a.textContent || '').replace(/\s+/g, ' ').trim(); if (q && t.includes(q)) return a.href; } return null; };
          let h = scan(document);
          if (!h) for (const f of document.querySelectorAll('iframe')) { try { h = scan(f.contentDocument); if (h) break; } catch {} }
          return h;
        }, titleQ).catch(() => null);
        if (!href) await page.waitForTimeout(2000);
      }
      if (href) { url = href; console.log(`■ サイト: ${site.title}`); break outer; }
    }
  }
  if (!url) { console.error(`✗ 「${titleQ}」の提出ページが見つかりません`); await browser.close(); process.exit(2); }
}
console.log(`▶ 提出ページ: ${url}`);
if (dryRun) { console.log('▶ --dry-run のため、添付もドラフト保存もせず終了します'); await saveState(context); await browser.close(); process.exit(0); }

const toolFrame = () => page.frames().find((f) => f.url().includes('/tool/')) || page.mainFrame();

// ── 添付 → ドラフト保存 ──
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);

const fileInput = toolFrame().locator('#clonableUpload');
if (!(await fileInput.count())) { console.error('✗ 添付欄(#clonableUpload)が見つかりません。提出画面でない可能性'); await browser.close(); process.exit(3); }
await fileInput.setInputFiles(file);
console.log(`▶ 添付: ${base}`);
await page.waitForTimeout(3000);

const saveBtn = toolFrame().locator('input[name=save][value="ドラフトを保存"]');
if (!(await saveBtn.count())) { console.error('✗ 「ドラフトを保存」ボタンが見つかりません'); await browser.close(); process.exit(4); }
await saveBtn.first().click();
await page.waitForTimeout(5000);
await page.waitForLoadState('domcontentloaded').catch(() => {});

// ── 検証: 保存済みドラフトに添付ファイル名が含まれるか ──
const after = await toolFrame().evaluate(() => document.body?.innerText || '');
const ok = after.includes(base);
console.log(ok ? `✓ ドラフト保存成功（添付 ${base} を確認）` : `⚠️ 添付ファイル名を確認できませんでした。画面を確認してください`);
await saveState(context);

if (saveOnly) {
  await browser.close();
  console.log(ok ? 'DONE（ドラフト保存のみ。課題ページで「提出」を押せば完了）' : 'DONE（要確認）');
  process.exit(ok ? 0 : 5);
}

// ── 提出画面を開いたまま待機（本人が「提出」を押す）。提出ボタンは自動で押さない ──
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
console.log('✓ 提出画面を開きました。添付を確認して「提出」ボタンを押せば完了します。');
console.log('  このブラウザは最大60分開いたままにします（手で閉じてもOK）。');
let closed = false;
browser.on('disconnected', () => { closed = true; });
const deadline = Date.now() + 60 * 60 * 1000;
while (!closed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5000));
console.log('DONE');
