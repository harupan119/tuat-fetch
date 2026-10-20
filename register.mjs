// register.mjs — SIRIUS 履修登録（コード指定登録）を引数の時間割コードごとに1件ずつ実行する。
//   使い方: node register.mjs <時間割コード> [<時間割コード> ...]
//   「登録完了」ボタンは押さない（最後に本人がブラウザで確認して押す）。
import { getSession, saveState, ENTRY } from './lib.mjs';

const codes = process.argv.slice(2);
if (!codes.length) { console.error('使い方: node register.mjs <時間割コード>...'); process.exit(1); }

const { browser, context, page } = await getSession();
page.on('dialog', async (d) => { console.log(`  [dialog:${d.type()}] ${d.message().replace(/\s+/g, ' ')}`); await d.accept(); });
try {
  for (const code of codes) {
    await page.goto(ENTRY + 'campussquare.do?_flowId=RSW0001000-flow', { waitUntil: 'networkidle' });
    await page.locator('a', { hasText: 'コード指定登録' }).first().click();
    await page.waitForLoadState('networkidle');
    await page.selectOption('#jikanwariShozokuCodeSelect', '02'); // 工学部
    await page.fill('#jikanwaricodeInput', code);
    await Promise.all([
      page.waitForLoadState('networkidle'),
      page.locator('input[type=button][onclick="rishuInsert()"]').click(),
    ]);
    await page.waitForTimeout(1500);
    const t = await page.evaluate(() => document.body.innerText);
    const msgs = t.split('\n').map((l) => l.trim())
      .filter((l) => /登録しました|登録されました|エラー|できません|重複|上限|既に|存在しません|誤り/.test(l)).slice(0, 5);
    console.log(`${code}: ${msgs.length ? msgs.join(' / ') : '(メッセージなし — 登録状況で要確認)'}`);
  }
  await saveState(context);
} finally {
  await browser.close();
}
