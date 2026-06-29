// inspect-submit.mjs — 課題提出ページの調査専用（閲覧のみ。添付も提出も一切しない）。
//   保存セッションで課題ページを開き、ログイン状態・提出UI(添付/提出ボタン)の有無を報告する。
//   使い方: node classroom/inspect-submit.mjs "<課題URL>"
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const STATE = path.join(os.homedir(), '.local/share/sirius-fetch/classroom_state.json');
const url = process.argv[2];
if (!url) { console.error('課題URLを指定してください'); process.exit(1); }
if (!fs.existsSync(STATE)) { console.error('未ログイン。先に node classroom/login.mjs'); process.exit(1); }

let browser;
try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
catch { browser = await chromium.launch({ headless: true }); }
const ctx = await browser.newContext({ storageState: STATE });
const page = await ctx.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);

const finalUrl = page.url();
const loggedOut = /accounts\.google|signin|ServiceLogin/i.test(finalUrl);
console.log('▶ 最終URL:', finalUrl);
console.log('▶ ログイン状態:', loggedOut ? '✗ ログイン要求された（セッション切れ）' : '✓ ログイン済み');

if (!loggedOut) {
  const ui = await page.evaluate(() => {
    const texts = (re) => [...document.querySelectorAll('[role="button"],button,[aria-label]')]
      .map((e) => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t && re.test(t));
    const uniq = (a) => [...new Set(a)].slice(0, 12);
    return {
      submit: uniq(texts(/提出|完了としてマーク|Turn in|Mark as done|Hand in/i)),
      attach: uniq(texts(/追加または作成|追加 \+|\+ 追加|Add or create|添付|アップロード|Upload|ファイル/i)),
      title: document.title,
      // 提出済み表示
      status: uniq(texts(/提出済み|Turned in|提出期限|割り当て済み|Assigned|未提出/i)),
    };
  });
  console.log('▶ ページタイトル:', ui.title);
  console.log('▶ 提出ボタン候補:', ui.submit.length ? ui.submit : '(検出なし)');
  console.log('▶ 添付ボタン候補:', ui.attach.length ? ui.attach : '(検出なし)');
  console.log('▶ 状態表示候補 :', ui.status.length ? ui.status : '(検出なし)');
  const shot = path.join(os.homedir(), '.local/share/sirius-fetch/output/submit-page.png');
  await page.screenshot({ path: shot, fullPage: true });
  console.log('▶ スクショ:', shot);
}

await browser.close();
