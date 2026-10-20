// classroom/fill-form.mjs — Google Formsに自動入力（送信ボタンは押さない）
//   使い方:
//     node classroom/fill-form.mjs <フォームURL> --data '<JSON>'
//     node classroom/fill-form.mjs <フォームURL> --file <data.json>
//     node classroom/fill-form.mjs <フォームURL> --data '<JSON>' --open
//
//   data JSON形式:
//     { "団体名": "<団体名>", "代表者": "<氏名>", "check:乳": true, "radio:2年": true,
//       "grid:学研災": "加入", "grid:バレーボール": ["経験なし"] }
//     - key がフォームの質問ラベルに一致（完全一致を優先、無ければ部分一致）→ value をテキスト入力
//     - "check:<value>" → チェックボックスで <value> を選択（グリッド以外）
//     - "radio:<value>" → ラジオボタンで <value> を選択（グリッド以外）
//     - "q:<質問ラベル>" → その質問の中で value の選択肢を選択（同じ選択肢が複数の質問に並ぶ時。配列なら複数）
//     - "grid:<行名>"   → グリッド（選択式/チェックボックス）の行 <行名> で value の列を選択。行名は部分一致、
//                          配列なら複数列。行名は form-contents.mjs の rows で分かる
//   既に選択済みの選択肢はクリックしない（再実行でチェックが外れない）。
//
//   複数ページのフォームは「次へ」で進みながら入力し、「送信」が出たページで止まる。送信は押さない。
//   最後に各ページの入力値を読み戻して表示し、どの質問にも当たらなかったキーを警告する。
//
//   --open: 画面ありで起動し、入力後10分間ブラウザを開いたままにする（本人が確認して送信）
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const STATE = path.join(os.homedir(), '.local/share/sirius-fetch/classroom_state.json');
if (!fs.existsSync(STATE)) { console.error('✗ 未ログイン。`node classroom/login.mjs`'); process.exit(1); }

const args = process.argv.slice(2);
const formUrl = args[0];
if (!formUrl || !/(docs\.google\.com\/forms|forms\.gle|forms\.google)/.test(formUrl)) {
  console.error('使い方: node classroom/fill-form.mjs <フォームURL> --data \'{"key":"val"}\' [--open]');
  process.exit(1);
}

let data = {};
const dataIdx = args.indexOf('--data');
const fileIdx = args.indexOf('--file');
if (dataIdx >= 0) data = JSON.parse(args[dataIdx + 1]);
else if (fileIdx >= 0) data = JSON.parse(fs.readFileSync(args[fileIdx + 1], 'utf8'));
else { console.error('✗ --data または --file が必要'); process.exit(1); }

const doOpen = args.includes('--open');

// 種別ごとに分離。pending から当たったものを消していき、最後に残ったものを警告する
const pending = new Map(); // id -> 表示名
const textEntries = [];    // {id, key, val}
const choiceEntries = [];  // {id, role, value}
const gridEntries = [];    // {id, row, col}
const scopedEntries = [];  // {id, q, val} 質問を指定して選択肢を選ぶ（同じ選択肢が複数の質問にある時）
for (const [k, v] of Object.entries(data)) {
  if (k.startsWith('check:') || k.startsWith('radio:')) {
    if (!v) continue;
    const id = k; pending.set(id, k);
    choiceEntries.push({ id, role: k.startsWith('check:') ? 'checkbox' : 'radio', value: k.slice(6) });
  } else if (k.startsWith('grid:')) {
    for (const col of [v].flat()) { const id = `${k}=${col}`; pending.set(id, id); gridEntries.push({ id, row: k.slice(5), col: String(col) }); }
  } else if (k.startsWith('q:')) {
    for (const val of [v].flat()) { const id = `${k}=${val}`; pending.set(id, id); scopedEntries.push({ id, q: k.slice(2), val: String(val) }); }
  } else {
    pending.set(k, k); textEntries.push({ id: k, key: k, val: String(v) });
  }
}

const norm = (s) => (s || '').replace(/\s*\*\s*$/, '').replace(/\s+/g, ' ').trim();
// グリッドのセルの aria-label: 「経験なし は バレーボール に対する応答です」/ 英語UI「経験なし, response for バレーボール」
const GRID_LABEL = /^(.*?) は (.*) に対する応答です$|^(.*?), response for (.*)$/;
const parseGridLabel = (l) => { const m = (l || '').match(GRID_LABEL); return m ? { col: m[1] ?? m[3], row: m[2] ?? m[4] } : null; };

let browser;
try { browser = await chromium.launch({ headless: !doOpen, channel: 'chrome' }); }
catch { browser = await chromium.launch({ headless: !doOpen }); }
const ctx = await browser.newContext({ storageState: STATE });
const page = await ctx.newPage();

await page.goto(formUrl, { waitUntil: 'domcontentloaded' });

if (/accounts\.google|ServiceLogin|signin/i.test(page.url()) && !page.url().includes('forms.google')) {
  console.error('✗ セッション切れ。`node classroom/login.mjs`');
  await browser.close(); process.exit(2);
}

const button = (re) => page.locator('[role=button]').filter({ hasText: re }).first();
const NEXT = /^(次へ|Next)$/;
const SUBMIT = /^(送信|Submit)$/;

// 開いた直後に ?pli=1 へのリダイレクトや「下書きで続行しますか？」ダイアログが挟まる。
// 「次へ」か「送信」が押せる状態になるまで待つ。
async function waitReady() {
  for (let i = 0; i < 20; i++) {
    if (page.url().includes('/alreadyresponded')) return 'responded';
    if (/回答の受け付けは終了しました|no longer accepting responses/.test(await page.locator('body').innerText().catch(() => ''))) return 'closed';
    const dlg = page.getByRole('dialog');
    if (await dlg.isVisible().catch(() => false)) {
      // 「続行」= 今開いている内容で続ける（「以前の下書きを使用」は選ばない）
      await dlg.getByText(/^(続行|Continue)$/).click().catch(() => {});
      await page.waitForTimeout(1000);
      continue;
    }
    if (await button(NEXT).isVisible().catch(() => false) || await button(SUBMIT).isVisible().catch(() => false)) return 'ready';
    await page.waitForTimeout(1000);
  }
  return 'timeout';
}

async function clickIfUnchecked(el) {
  if ((await el.getAttribute('aria-checked')) !== 'true') await el.click();
}

async function fillCurrentPage() {
  const blocks = await page.$$('[role=listitem]');
  const items = [];
  for (const block of blocks) {
    const label = norm(await block.evaluate(el => el.querySelector('[role="heading"]')?.textContent || ''));
    if (label) items.push({ block, label });
  }
  // メール記録の同意欄など listitem の外にある質問: 見出しから親をさかのぼり、入力部品を含む最初の要素を質問ブロックとみなす
  for (const h of await page.$$('[role=heading]')) {
    const block = await h.evaluateHandle(el => {
      if (el.closest('[role=listitem]')) return null;
      for (let p = el.parentElement, i = 0; p && i < 6; p = p.parentElement, i++) {
        if (p.querySelector('[role=radio], [role=checkbox], input[type=text], input[type=email], textarea')) return p;
      }
      return null;
    }).then(x => x.asElement());
    if (!block) continue;
    const label = norm(await h.textContent());
    if (label) items.push({ block, label });
  }

  // テキスト: 完全一致の質問を優先、無ければ部分一致の最初の質問
  for (const t of textEntries) {
    if (!pending.has(t.id)) continue;
    const hit = items.find(it => it.label === t.key) || items.find(it => it.label.includes(t.key));
    if (!hit) continue;
    const input = await hit.block.$('input[type="text"]:visible, input[type="email"]:visible, input:not([type]):visible, textarea:visible');
    if (!input) continue;
    await input.fill(t.val);
    pending.delete(t.id);
    console.log(`✓ [text] ${hit.label} → "${t.val}"`);
  }

  // 質問指定の選択肢: ラベルは完全一致→前方一致→部分一致の順。選択肢を持つ質問だけを候補にする
  const stripBidi = (s) => (s || '').replace(/[‪-‮‎‏]/g, '').trim();
  for (const e of scopedEntries) {
    if (!pending.has(e.id)) continue;
    const cands = [];
    for (const it of items) if (await it.block.$('[role=radio], [role=checkbox]')) cands.push(it);
    const hit = cands.find(it => it.label === e.q) || cands.find(it => it.label.startsWith(e.q)) || cands.find(it => it.label.includes(e.q));
    if (!hit) continue;
    for (const el of await hit.block.$$('[role=radio], [role=checkbox]')) {
      const [aria, dv] = await el.evaluate(x => [x.getAttribute('aria-label'), x.getAttribute('data-value')]);
      // true は「その質問の唯一の選択肢を選ぶ」（メール記録の同意チェックなど、値が画面依存のもの）
      if (e.val !== 'true' && stripBidi(dv ?? aria) !== stripBidi(e.val)) continue;
      await clickIfUnchecked(el); pending.delete(e.id);
      console.log(`✓ [q] ${hit.label.slice(0, 30)} → "${e.val}"`);
      break;
    }
  }

  // 選択肢: グリッドのセル以外で、data-value（無ければ aria-label）が一致するもの
  const ctrls = await page.$$('[role=radio], [role=checkbox]');
  for (const el of ctrls) {
    const [role, aria, dv] = await el.evaluate(e => [e.getAttribute('role'), e.getAttribute('aria-label'), e.getAttribute('data-value')]);
    const g = parseGridLabel(aria);
    if (g) {
      for (const e of gridEntries) {
        if (pending.has(e.id) && g.col === e.col && g.row.includes(e.row)) {
          await clickIfUnchecked(el); pending.delete(e.id);
          console.log(`✓ [grid] ${g.row} → "${g.col}"`);
        }
      }
      continue;
    }
    const value = dv ?? aria;
    for (const c of choiceEntries) {
      if (pending.has(c.id) && c.role === role && c.value === value) {
        await clickIfUnchecked(el); pending.delete(c.id);
        console.log(`✓ [${role}] "${value}"`);
      }
    }
  }
}

async function readBack() {
  return page.evaluate(() => ({
    // 画面外の隠し入力(遷移元URL等)を除く
    text: [...document.querySelectorAll('input[type=text],input[type=email],textarea')].filter(i => i.offsetParent).map(i => i.value).filter(Boolean),
    checked: [...document.querySelectorAll('[role=radio][aria-checked=true],[role=checkbox][aria-checked=true]')]
      .map(e => e.getAttribute('aria-label') || e.getAttribute('data-value')),
  }));
}

const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');
fs.mkdirSync(OUT, { recursive: true });

const ready = await waitReady();
if (ready !== 'ready') {
  const msg = { responded: '既に回答済み（1回のみ回答のフォーム）', closed: '回答の受付は終了している', timeout: 'フォームの画面にならなかった' }[ready];
  console.error(`✗ ${msg}: ${page.url()}`);
  await browser.close(); process.exit(3);
}

for (let n = 1; n <= 20; n++) {
  await fillCurrentPage();
  console.log(`— ${n}ページ目の入力値: ${JSON.stringify(await readBack())}`);
  if (await button(SUBMIT).isVisible().catch(() => false)) break;
  const next = button(NEXT);
  if (!(await next.isVisible().catch(() => false))) break;
  await next.click();
  await page.waitForTimeout(2500);
  // 必須未入力などで進めなければ止まる
  const stillHere = await page.locator('[role=listitem] [role=alert]').filter({ hasText: /\S/ }).count();
  if (stillHere) { console.error(`✗ ${n}ページ目から進めない（必須項目の未入力など）。ここで止める`); break; }
}

if (pending.size) console.error(`⚠️ どの質問にも当たらなかったキー: ${[...pending.values()].join(', ')}`);

const ssPath = path.join(OUT, `form-filled-${Date.now()}.png`);
await page.screenshot({ path: ssPath, fullPage: true });
console.log(`📸 ${ssPath}`);

if (doOpen) {
  console.log('✓ 入力完了。ブラウザで確認して送信してください（10分で閉じます）。');
  await new Promise(r => setTimeout(r, 10 * 60 * 1000));
} else {
  console.log('✓ 入力完了（headless）。--open で本人確認用にブラウザを開けます。');
}

await browser.close();
