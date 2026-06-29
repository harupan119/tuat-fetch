// fetch.mjs — SIRIUS から「時間割 / 休講・補講 / お知らせ」を一括取得して保存する。
//   セッションが切れていたら自動で headed ログインに切り替える。
//   出力: ~/.local/share/sirius-fetch/output/{timetable,kyuko,oshirase}.json と summary.md
import { getSession, saveState, ENTRY, DATA_DIR } from './lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const OUT = path.join(DATA_DIR, 'output');

// ページ内の全テーブルを「行×セル」配列で取り出す
async function allTables(page) {
  return page.evaluate(() => [...document.querySelectorAll('table')].map(t =>
    [...t.querySelectorAll('tr')].map(tr =>
      [...tr.querySelectorAll('th,td')].map(c => (c.innerText || '').replace(/\s+/g, ' ').trim())
    ).filter(r => r.some(c => c))
  ).filter(rows => rows.length));
}

// ヘッダ語を含むテーブルを選ぶ
function pickTable(tables, ...keywords) {
  return tables.find(rows => rows.slice(0, 3).some(r => keywords.every(k => r.join(' ').includes(k))));
}


// 1) 時間割・履修科目一覧（グリッド: 限ラベル＋月〜土の6セルが各限ぶん並ぶ）
async function fetchTimetable(page) {
  await page.goto(ENTRY + 'campussquare.do?_flowId=RSW0001000-flow', { waitUntil: 'networkidle' });

  // グリッド表の「スロットセル」(限ラベル / 科目 / 未登録)を文書順で取得
  const cells = await page.evaluate(() => {
    const tables = [...document.querySelectorAll('table')];
    const grid = tables.find(t => /月曜日/.test(t.innerText) && /限/.test(t.innerText));
    if (!grid) return [];
    // 子テーブルを持たない末端セルだけ＝実データ
    return [...grid.querySelectorAll('td,th')]
      .filter(c => !c.querySelector('table'))
      .map(c => (c.innerText || '').replace(/\s+/g, ' ').trim())
      .filter(Boolean);
  });

  const DAYS = ['月', '火', '水', '木', '金', '土'];
  const courses = [];
  let period = null, dayIdx = 0;
  for (const t of cells) {
    const pm = t.match(/^(\d)限$/);
    if (pm) { period = pm[1]; dayIdx = 0; continue; }
    if (t === '未登録') { dayIdx++; continue; }
    // 科目セル: 「コード 科目…担当 X.X単位」
    const cm = t.match(/^(\S+)\s+(.+?)\s+([\d.]+)単位$/);
    if (cm && period && dayIdx < 6) {
      courses.push({ 曜限: `${DAYS[dayIdx]}${period}`, code: cm[1], 科目担当: cm[2], 単位: cm[3] });
      dayIdx++;
    }
  }

  // 学期メタ
  const tables = await allTables(page);
  const meta = {};
  const metaTbl = pickTable(tables, '年度', '学期');
  if (metaTbl) for (const r of metaTbl) for (let i = 0; i + 1 < r.length; i += 2) if (r[i]) meta[r[i]] = r[i + 1];
  return { meta, count: courses.length, courses };
}

// 2) 休講・補講（今週）
async function fetchKyuko(page) {
  await page.goto(ENTRY + 'campussquare.do?_flowId=KHW0001100-flow', { waitUntil: 'networkidle' });
  // 中身のあるセル(休講/補講/教室変更等)をテキストで拾う
  const entries = await page.evaluate(() => {
    const out = [];
    for (const cell of document.querySelectorAll('td')) {
      if (cell.querySelector('table')) continue;        // 末端セルのみ
      const t = (cell.innerText || '').replace(/\s+/g, ' ').trim();
      if (!/(休講|補講|教室変更|時間変更)/.test(t)) continue;
      // 凡例/ヘッダ/ボタンを除外（実エントリは科目や教室を伴う）
      if (/凡例|初期状態/.test(t)) continue;
      if (/^(休講|補講|教室変更|時間変更|開講)$/.test(t)) continue;
      out.push(t);
    }
    return [...new Set(out)];
  });
  return { count: entries.length, entries };
}

// 3) お知らせ掲示（ジャンル別の掲示タイトル一覧）
const GENRE = { '642': '全学', '643': '府中-教務', '644': '府中-学生生活', '645': '小金井-教務', '661': '小金井-学生生活', '662': '小金井-遺失物', '663': '図書館', '601': '個人', '621': '授業' };
async function fetchOshirase(page) {
  await page.goto(ENTRY + 'campussquare.do?_flowId=KJW0001100-flow', { waitUntil: 'networkidle' });
  const items = await page.evaluate(() => [...document.querySelectorAll('a[href*="_eventId=confirm"]')].map(a => {
    const u = new URL(a.href);
    return { title: (a.textContent || '').replace(/\s+/g, ' ').trim(), genrecd: u.searchParams.get('genrecd') };
  }).filter(x => x.title));
  for (const it of items) it.genre = GENRE[it.genrecd] || it.genrecd;
  return { count: items.length, items };
}

function mdSummary(tt, ky, os) {
  const L = [];
  L.push(`# SIRIUS 取得結果  (${new Date().toLocaleString('ja-JP')})`, '');
  L.push(`## 時間割 / 履修科目  (${tt.meta['年度・学期'] || ''}, ${tt.count}件)`);
  const order = { 月: 0, 火: 1, 水: 2, 木: 3, 金: 4, 土: 5 };
  const sorted = [...tt.courses].sort((a, b) =>
    (order[a.曜限[0]] - order[b.曜限[0]]) || (a.曜限.slice(1) - b.曜限.slice(1)));
  for (const c of sorted) {
    L.push(`- \`${c.曜限}\` ${c.科目担当}（${c.単位}単位）[${c.code}]`);
  }
  L.push('', `## 休講・補講（今週）  ${ky.count}件`);
  ky.entries.length ? ky.entries.forEach(e => L.push(`- ${e}`)) : L.push('- なし');
  L.push('', `## お知らせ掲示  ${os.count}件`);
  for (const it of os.items) if (it.genre !== '授業' || true) L.push(`- [${it.genre}] ${it.title}`);
  return L.join('\n') + '\n';
}

// ---- main ----
const { browser, context, page } = await getSession();
console.log('▶ 取得中…');
const tt = await fetchTimetable(page); console.log(`  時間割: ${tt.count}件`);
const ky = await fetchKyuko(page);     console.log(`  休講補講: ${ky.count}件`);
const os = await fetchOshirase(page);  console.log(`  お知らせ: ${os.count}件`);
await saveState(context);
await browser.close();

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'timetable.json'), JSON.stringify(tt, null, 2));
await fs.writeFile(path.join(OUT, 'kyuko.json'), JSON.stringify(ky, null, 2));
await fs.writeFile(path.join(OUT, 'oshirase.json'), JSON.stringify(os, null, 2));
await fs.writeFile(path.join(OUT, 'summary.md'), mdSummary(tt, ky, os));
console.log(`✓ 保存: ${OUT}/`);
console.log(`  summary.md / timetable.json / kyuko.json / oshirase.json`);
