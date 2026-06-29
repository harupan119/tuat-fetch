// attach.mjs — Classroom課題にローカルファイルを「添付」だけする（提出ボタンは押さない）。
//   添付はあなたのアカウントにドラフト保存される → 後でリンクを開いて「提出」を押すだけ。
//   使い方: node classroom/attach.mjs "<課題URL>" "<ファイルパス>"
import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const OPEN = process.argv.includes('--open'); // 添付後、本人のChromeで課題ページを開く

const STATE = path.join(os.homedir(), '.local/share/sirius-fetch/classroom_state.json');
const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');
const url = process.argv[2];
const file = process.argv[3];
if (!url || !file) { console.error('使い方: node classroom/attach.mjs "<URL>" "<file>"'); process.exit(1); }
if (!fs.existsSync(file)) { console.error('ファイルが無い:', file); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });
const shot = (n) => path.join(OUT, `attach-${n}.png`);

let browser;
try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
catch { browser = await chromium.launch({ headless: true }); }
const ctx = await browser.newContext({ storageState: STATE, acceptDownloads: false });
const page = await ctx.newPage();

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(5000);
if (/accounts\.google|signin|ServiceLogin/i.test(page.url())) { console.error('✗ セッション切れ。node classroom/login.mjs'); await browser.close(); process.exit(2); }
console.log('✓ ログイン済み:', page.url());
await page.screenshot({ path: shot('1-open') });

// 表示されている要素だけを文字列でJSクリック（Classroomは非表示の重複要素がありロケータが掴めない）
async function clickVisible(reSrc, roles = '[role="button"],button,[role="menuitem"]') {
  return await page.evaluate(({ reSrc, roles }) => {
    const re = new RegExp(reSrc);
    for (const e of document.querySelectorAll(roles)) {
      const t = (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim();
      if (!re.test(t)) continue;
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { e.click(); return t; }
    }
    return null;
  }, { reSrc, roles });
}

// 1) 「追加または作成」をJSクリック
const opened = await clickVisible('追加または作成|Add or create');
await page.waitForTimeout(1500);
await page.screenshot({ path: shot('2-menu') });
console.log('✓ 追加または作成:', opened || '(見つからず)');

// 2) メニューの「ファイル」をJSクリック（直接filechooserが出る場合に備え先に待受）
const fcPromise = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
const picked = await clickVisible('^ファイル$|^File$', '[role="menuitem"],[role="button"],span,div');
await page.waitForTimeout(3000);
await page.screenshot({ path: shot('3-after-file') });
console.log('✓ ファイル項目:', picked || '(見つからず)');

// デバッグ: フレームと file input を列挙
console.log('— frames —');
for (const f of page.frames()) console.log('  ', f.url().slice(0, 90));
for (const f of page.frames()) {
  const n = await f.locator('input[type="file"]').count().catch(() => 0);
  if (n) console.log(`  input[type=file] x${n} @ ${f.url().slice(0, 60)}`);
}

let chooser = await fcPromise;

// 3) filechooserが出なければ、Driveアップロード・ピッカーのiframe内で「参照」を押す
if (!chooser) {
  console.log('  直接のfilechooser無し → ピッカーiframeを探索');
  for (const f of page.frames()) {
    const u = f.url();
    if (!/docs\.google\.com|picker|drive\.google/.test(u)) continue;
    console.log('   frame:', u.slice(0, 80));
    const browse = f.locator('text=/参照|ブラウズ|デバイス|Browse|select files|Select files from your device/i').first();
    if (await browse.count().catch(() => 0)) {
      const fc2 = page.waitForEvent('filechooser', { timeout: 8000 }).catch(() => null);
      await browse.click().catch(() => {});
      chooser = await fc2;
      if (chooser) break;
    }
    // iframe内に隠れた input[type=file] があれば直接set
    const input = f.locator('input[type="file"]').first();
    if (await input.count().catch(() => 0)) {
      await input.setInputFiles(file).catch((e) => console.log('   input.setInputFiles失敗:', e.message));
      console.log('   iframe input に setInputFiles 実行');
      chooser = 'done';
      break;
    }
  }
}

if (chooser && chooser !== 'done') {
  await chooser.setFiles(file);
  console.log('✓ filechooser にファイルをセット:', path.basename(file));
}

// 4) アップロード完了を待つ（添付が課題に現れるまで）
await page.waitForTimeout(8000);
await page.screenshot({ path: shot('4-after-upload'), fullPage: true });

const state = await page.evaluate(() => {
  const txt = (re) => [...document.querySelectorAll('[role="button"],button,[aria-label],div,span,a')]
    .map((e) => (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t && re.test(t));
  const uniq = (a) => [...new Set(a)].slice(0, 8);
  return {
    submit: uniq(txt(/^提出$|提出する|Turn in|Hand in/)),
    attached: uniq(txt(/\.pdf|07回|添付/i)),
  };
});
console.log('▶ 提出ボタン:', state.submit.length ? state.submit : '(まだ無し=添付未完かも)');
console.log('▶ 添付らしき表示:', state.attached.length ? state.attached : '(検出なし)');
console.log('▶ スクショ:', OUT, '(attach-1〜4)');

await ctx.storageState({ path: STATE }); // セッション更新（添付ドラフトを保持）
await browser.close();

const attached = state.attached.some((t) => /\.pdf|添付ファイル/i.test(t));
if (OPEN && attached) {
  execFile('open', ['-a', 'Google Chrome', url], (e) => e && console.log('  Chrome起動失敗:', e.message));
  console.log('▶ あなたのChromeで課題ページを開きました。青い「提出」を押してください。');
} else if (OPEN) {
  console.log('⚠ 添付が確認できなかったのでChromeは開きません。スクショ(output/attach-4)を確認してください。');
}
console.log('— 完了（提出ボタンは押していません）—');
