// keepalive.mjs — セッションを延命する単発スクリプト（cron/launchdから定期実行する想定）。
//   生きていれば: SIRIUSの extendSession() を呼び、Sakaiの session を ping して
//   idleタイマーをリセット → state.json を保存。
//   切れていれば: ログに記録して exit 2（headlessなので自動再ログインは不可）。
// 使い方: node keepalive.mjs   （< 120分間隔で回せば実質無期限に延命）
import { launch, saveState, isLoggedIn, openSakai, autoLogin, LMS, ENTRY, DATA_DIR } from './lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const LOG = path.join(DATA_DIR, 'keepalive.log');
const log = async (m) => {
  const line = `${new Date().toISOString()}  ${m}\n`;
  await fs.appendFile(LOG, line).catch(() => {});
  process.stdout.write(line);
};

let { browser, context, page } = await launch({ headless: true });
try {
  // ポータルへ。SSOに飛ばされたら= セッション切れ
  await page.goto(ENTRY + 'portal.do?page=main', { waitUntil: 'domcontentloaded' });
  try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
  if (!isLoggedIn(page) || /auth|login/i.test(page.url())) {
    // セッション切れ → 自動ログインで復活を試みる
    await log('… セッション切れ。自動ログインを試行。');
    await browser.close();
    if (!(await autoLogin({ headless: true }))) { await log('✗ 自動ログイン失敗。`node login.mjs` で手動ログインが必要。'); process.exit(2); }
    ({ browser, context, page } = await launch({ headless: true }));
    await page.goto(ENTRY + 'portal.do?page=main', { waitUntil: 'domcontentloaded' });
    try { await page.waitForLoadState('networkidle', { timeout: 6000 }); } catch {}
  }

  // SIRIUS側を延命
  const ext = await page.evaluate(() => { try { extendSession(); return true; } catch { return false; } });

  // Sakai側を確立して ping（idleタイマーをリセット）
  let sakai = false;
  if (await openSakai(page)) {
    const r = await context.request.get(LMS + '/direct/session/current.json', { headers: { Accept: 'application/json' } });
    if (r.ok()) { const j = await r.json(); sakai = !!j.active; }
  }

  await saveState(context);
  await log(`✓ 延命 (SIRIUS extend:${ext} / Sakai active:${sakai})`);
} catch (e) {
  await log('✗ エラー: ' + e.message);
  await browser.close();
  process.exit(1);
}
await browser.close();
