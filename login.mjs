// login.mjs — 初回/セッション切れ時の対話ログイン。
//   headed ブラウザを開き、人間がSIRIUS(Extic SSO)にログインするのを待つ。
//   成功したら cookie を state.json に保存し、ダッシュボード構造を dump する。
import { launch, saveState, ENTRY, isLoggedIn, DATA_DIR } from './lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const { browser, context, page } = await launch({ headless: false });

console.log('▶ SIRIUS を開きます。ブラウザ画面でログインしてください（パスキー/OTP含む）。');
console.log('  「この端末を記憶」等があればオンに。');
await page.goto(ENTRY, { waitUntil: 'domcontentloaded' });

// ログイン完了(=SIRIUS本体に到達)まで最大5分待つ
const DEADLINE = Date.now() + 5 * 60 * 1000;
while (Date.now() < DEADLINE) {
  if (isLoggedIn(page) && !/auth|login/i.test(page.url())) {
    try { await page.waitForLoadState('networkidle', { timeout: 8000 }); } catch {}
    break;
  }
  await page.waitForTimeout(1000);
}

if (!isLoggedIn(page)) {
  console.error('✗ 5分以内にログインを検知できませんでした。再実行してください。');
  await browser.close();
  process.exit(1);
}

console.log('✓ ログイン検知:', page.url());
await saveState(context);
console.log('✓ セッションを保存:', path.join(DATA_DIR, 'state.json'), '(120分有効)');

// ---- ダッシュボード構造を dump ----
const frames = page.frames();
const dump = { capturedAt: new Date().toISOString(), topUrl: page.url(), title: await page.title(), frameCount: frames.length, frames: [] };
for (let i = 0; i < frames.length; i++) {
  const frame = frames[i];
  let links = [];
  try {
    links = await frame.$$eval('a', as => as.map(a => ({
      text: (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      href: a.href, onclick: a.getAttribute('onclick')?.slice(0, 120) || null,
    })).filter(l => l.text || l.onclick));
  } catch {}
  dump.frames.push({ label: `frame[${i}]`, url: frame.url(), links });
}
const outDir = path.join(DATA_DIR, 'inspect');
await fs.mkdir(outDir, { recursive: true });
await fs.writeFile(path.join(outDir, 'dashboard.json'), JSON.stringify(dump, null, 2));
await fs.writeFile(path.join(outDir, 'dashboard.html'), await page.content());
await page.screenshot({ path: path.join(outDir, 'dashboard.png'), fullPage: true });
console.log('✓ 構造を保存:', outDir + '/dashboard.{json,html,png}');

await browser.close();
