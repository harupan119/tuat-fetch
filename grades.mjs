// grades.mjs — SIRIUS「単位修得状況照会」(SIW0001300)から全成績を取得して表示・保存する。
//   成績公開日など特定のタイミングで手で回す用。通知・差分検出・定期実行はしない。
//   出力: ~/.local/share/sirius-fetch/output/grades.json（ローカルのみ）
//   ⚠️ 成績評価値はローカルにだけ置く。外部と同期するフォルダには書き出さない。
//
//   node grades.mjs         … 最新学期を表示（保存は全学期）
//   node grades.mjs --all   … 全学期を表示
import { getSession, saveState, ENTRY, DATA_DIR } from './lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(DATA_DIR, 'output');
const showAll = process.argv.includes('--all');

// ページ内の全テーブルを「行×セル」配列で取り出す（入れ子テーブルは無い画面）
async function allTables(page) {
  return page.evaluate(() => [...document.querySelectorAll('table')].map((t) =>
    [...t.querySelectorAll('tr')].map((tr) =>
      [...tr.querySelectorAll('th,td')].map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim()))
      .filter((r) => r.some((c) => c))));
}

// 1行目を見出しとして、以降の行を {見出し: 値} にする
const toRecords = (rows) => rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i] ?? ''])));

const { browser, context, page } = await getSession();
let tables;
try {
  // 表示範囲「過去を含めた全成績」で画面表示。フォームは _flowExecutionKey 付きなのでDOM操作で送る。
  await page.goto(ENTRY + 'campussquare.do?_flowId=SIW0001300-flow', { waitUntil: 'domcontentloaded' });
  await page.locator('#spanType1').check();
  await page.locator('input[type=submit][value*="画面に表示する"]').click();
  // 「評語」の見出しはHTML受信の途中で先に現れる。それだけで読むと表の後半とGPA表が欠ける
  // （実測: 41件中31件で打ち切り）。文書の解析完了まで待つ。
  await page.waitForFunction(() => document.readyState !== 'loading'
    && [...document.querySelectorAll('th,td')].some((c) => c.innerText.trim() === '評語'), null, { timeout: 20000 })
    .catch(() => {});
  tables = await allTables(page);
  await saveState(context);
} finally {
  await browser.close();
}

// 成績表: 見出しに「科目」「評語」を持つ表。列は No./科目大区分/科目中区分/科目小区分/科目/単位数/修得年度/修得学期/評語/合否/遠隔/主担当教員
const gradeRows = tables.find((rows) => rows[0]?.includes('科目') && rows[0]?.includes('評語'));
// 通算GPA表はページ末尾にあるので、これが無ければ読み取りが途中で切れている
const total = tables.find((rows) => rows[0]?.[0] === '通算GPA');
if (!gradeRows || !total) {
  // 欠けた結果で既存の grades.json を潰さない
  console.error(`✗ ${!gradeRows ? '成績表' : '通算GPA表'}が見つからない（読み取りが途中で切れたか、画面構造が変わった）。grades.json は更新していない。`);
  process.exit(1);
}
const records = toRecords(gradeRows).map(({ 'No.': _, ...r }) => r);

// GPA: 「通算GPA <値> 通算GPT <値>」の横並び表と、年度×学期の表
const gpa = { 通算: {}, 年度別: [] };
for (let i = 0; i + 1 < total[0].length; i += 2) gpa.通算[total[0][i].replace('通算', '')] = total[0][i + 1];
const yearly = tables.find((rows) => rows[0]?.[0] === '年度' && rows[0].includes('年度GPA'));
if (yearly) gpa.年度別 = toRecords(yearly);

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'grades.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), gpa, records }, null, 2));

// 表示: 学期ごとにまとめ、評語の良い順に並べる
const TERM_ORDER = { 前期: 1, 後期: 2 };
const GRADE_ORDER = ['S', 'A', 'B', 'C', 'D', 'F'];
const rank = (g) => { const i = GRADE_ORDER.indexOf(g); return i < 0 ? GRADE_ORDER.length : i; };
const terms = [...new Set(records.map((r) => `${r.修得年度}\t${r.修得学期}`))]
  .map((k) => k.split('\t'))
  .sort((a, b) => (a[0] - b[0]) || ((TERM_ORDER[a[1]] ?? 0) - (TERM_ORDER[b[1]] ?? 0)));
const shown = showAll ? terms : terms.slice(-1);

console.log(`✓ 成績 ${records.length}件（全学期）→ ${OUT}/grades.json`);
for (const [year, term] of shown) {
  const rs = records.filter((r) => r.修得年度 === year && r.修得学期 === term).sort((a, b) => rank(a.評語) - rank(b.評語));
  const credits = rs.reduce((s, r) => s + (parseFloat(r.単位数) || 0), 0);
  const y = gpa.年度別.find((g) => g.年度 === year);
  const termGpa = y?.[`${term}GPA`] ? `  GPA ${y[`${term}GPA`]}（GPT ${y[`${term}GPT`]}）` : '';
  console.log(`\n${year}年度 ${term}  ${rs.length}科目 / ${credits}単位${termGpa}`);
  for (const r of rs) console.log(`  ${r.評語.padEnd(2)} ${r.科目}（${r.単位数}単位）${r.合否 && r.合否 !== '合' ? `  ⚠️${r.合否}` : ''}`);
}
if (gpa.通算.GPA) console.log(`\n通算 GPA ${gpa.通算.GPA}（GPT ${gpa.通算.GPT}）`);
