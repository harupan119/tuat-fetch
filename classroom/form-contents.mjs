// classroom/form-contents.mjs — Google Formsの質問・選択肢・締切状態を取得
//   旧: 画面のDOM([data-params])を読んでいた。複数ページのフォームは1ページ目しか見えず、
//       「メールだけの1ページ目＋本体の2ページ目」型だと0問と出た。グリッドの行も区別できなかった。
//   新: ページに埋め込まれた FB_PUBLIC_LOAD_DATA_ を解析する。全ページの質問・種類・必須・
//       選択肢・グリッドの行・entry ID が一度に取れる。
//
//   使い方:
//     node classroom/form-contents.mjs <フォームURL> [<フォームURL2> ...]
//     node classroom/form-contents.mjs --from <scan-forms出力JSON>
//   出力: stdout に JSON + ~/.local/share/sirius-fetch/output/form-contents.json
//   各質問: {page, label, description, required, type, options, rows?, entryId|entryIds}
//     type: short_text / long_text / radio / select / checkbox / scale / radio_grid / checkbox_grid /
//           date / time / file_upload / rating / unknown(<数値>)
//     rows: グリッドの行。fill-form.mjs の "grid:<行名>" にそのまま使える
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const STATE = path.join(os.homedir(), '.local/share/sirius-fetch/classroom_state.json');
if (!fs.existsSync(STATE)) { console.error('✗ 未ログイン。`node classroom/login.mjs`'); process.exit(1); }

const args = process.argv.slice(2);
let formUrls = [];

if (args[0] === '--from' && args[1]) {
  const data = JSON.parse(fs.readFileSync(args[1], 'utf8'));
  formUrls = data.map(f => ({ name: f.name, url: f.url || f.href }));
} else if (args.length > 0) {
  formUrls = args.map(url => ({ name: '', url }));
} else {
  console.error('使い方:\n  node classroom/form-contents.mjs <URL> [<URL2> ...]\n  node classroom/form-contents.mjs --from <scan-forms出力.json>');
  process.exit(1);
}

// FB_PUBLIC_LOAD_DATA_[1][1] の各要素: [itemId, タイトル, 説明, 種類コード, 回答欄[], ...]
//   回答欄: [entryId, 選択肢[[ラベル,…,その他フラグ(4)]], 必須(1/0), [グリッド行名], …, [グリッド複数選択(1/0)](11)]
const TYPES = { 0: 'short_text', 1: 'long_text', 2: 'radio', 3: 'select', 4: 'checkbox', 5: 'scale',
  9: 'date', 10: 'time', 13: 'file_upload', 18: 'rating' };
const NON_QUESTION = new Set([6, 11, 12]); // タイトルと説明のみ / 画像 / 動画

function parseItems(items) {
  const questions = [];
  let page = 1;
  for (const it of items || []) {
    const [, label, description, code, fields] = it;
    if (code === 8) { page++; continue; } // セクション区切り = 次のページ
    if (NON_QUESTION.has(code)) continue;
    const f = fields || [];
    const options = (f[0]?.[1] || []).map(o => (o[4] === 1 ? '__other_option__' : o[0])).filter(v => v != null);
    const q = { page, label: label || '', description: description || '', required: f.some(x => x?.[2] === 1) };
    if (code === 7) {
      q.type = f[0]?.[11]?.[0] === 1 ? 'checkbox_grid' : 'radio_grid';
      q.options = options;
      q.rows = f.map(x => x?.[3]?.[0] ?? '');
      q.entryIds = f.map(x => x?.[0]);
    } else {
      q.type = TYPES[code] || `unknown(${code})`;
      q.options = options;
      q.entryId = f[0]?.[0];
    }
    questions.push(q);
  }
  return questions;
}

// 開いた直後に ?pli=1 等へのリダイレクトが挟まり、読み取り中に実行コンテキストが消えることがある。
// フォームのデータが現れる（または受付終了と分かる）まで最大15秒読み直す。
const CLOSED_RE = /回答の受け付けは終了しました|フォームは閉じられています|no longer accepting responses|This form is closed/;
async function readPage(page) {
  let raw = null;
  for (let i = 0; i < 15; i++) {
    try {
      await page.waitForLoadState('domcontentloaded');
      raw = await page.evaluate(() => ({
        fb: typeof FB_PUBLIC_LOAD_DATA_ !== 'undefined' ? FB_PUBLIC_LOAD_DATA_ : null,
        heading: document.querySelector('[role="heading"]')?.textContent?.trim() || document.title,
        bodyText: document.body.innerText || '',
      }));
      if (raw.fb || CLOSED_RE.test(raw.bodyText) || page.url().includes('/alreadyresponded')) return raw;
    } catch (e) {
      if (!/context was destroyed|navigation/i.test(e.message)) throw e;
    }
    await page.waitForTimeout(1000);
  }
  return raw || { fb: null, heading: '', bodyText: '' };
}

let browser;
try { browser = await chromium.launch({ headless: true, channel: 'chrome' }); }
catch { browser = await chromium.launch({ headless: true }); }
const ctx = await browser.newContext({ storageState: STATE });

const results = [];

for (const form of formUrls) {
  console.error(`取得中: ${form.name || form.url}`);
  const page = await ctx.newPage();
  try {
    await page.goto(form.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    if (/accounts\.google|ServiceLogin|signin/i.test(page.url()) && !page.url().includes('forms.google')) {
      console.error('  → ログイン要求（スキップ）');
      results.push({ ...form, status: 'login_required', questions: [] });
      await page.close(); continue;
    }

    const raw = await readPage(page);
    const isClosed = CLOSED_RE.test(raw.bodyText);

    // 「1回のみ回答」のフォームに回答済みだと /alreadyresponded に飛ばされ、質問は見えない
    const responded = page.url().includes('/alreadyresponded');

    let data;
    if (responded) data = { title: raw.heading, description: '', closed: false, alreadyResponded: true, pages: 0, questions: [] };
    else if (isClosed) data = { title: raw.heading, description: '', closed: true, pages: 0, questions: [] };
    else if (!raw.fb) throw new Error('FB_PUBLIC_LOAD_DATA_ が無い（フォーム画面ではない可能性）');
    else {
      const questions = parseItems(raw.fb[1]?.[1]);
      data = { title: (raw.fb[1]?.[8] || raw.fb[3] || raw.heading).trim(), description: raw.fb[1]?.[0] || '', closed: false,
        pages: Math.max(1, ...questions.map(q => q.page)), questions };
    }

    const state = data.alreadyResponded ? '回答済み（1回のみ回答のフォーム）' : data.closed ? '受付終了' : `${data.questions.length}問 / ${data.pages}ページ`;
    console.error(`  ✓ ${data.title} (${state})`);
    results.push({ ...form, ...data });
  } catch (e) {
    console.error(`  ✗ ${e.message.slice(0, 100)}`);
    results.push({ ...form, status: 'error', error: e.message });
  }
  await page.close();
}

await browser.close();

const OUT = path.join(os.homedir(), '.local/share/sirius-fetch/output');
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'form-contents.json'), JSON.stringify(results, null, 2));
console.error(`✓ ${results.length}件 → ${OUT}/form-contents.json`);
console.log(JSON.stringify(results, null, 2));
