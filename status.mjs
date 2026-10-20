// status.mjs — Sakai課題の「提出したか」を確認する（読み取り専用。ボタンは一切押さない）
//   assignments.mjs が未提出だけを出すのに対し、こちらは提出済みも含めた全課題の状態を出す。
//   使い方:
//     node status.mjs                          # 今学期の全科目・全課題の状態一覧
//     node status.mjs --course "Academic"      # 科目名(サイト名)に部分一致で絞る
//     node status.mjs --title "14"             # 課題タイトルに部分一致で絞る
//     node status.mjs --course "Academic" --title "14 期末" --detail   # 提出物の添付まで見る
//   出力: 標準出力 ＋ ~/.local/share/sirius-fetch/output/status.json
import { getSession, openSakai, saveState, LMS, DATA_DIR, sitesWithAssignments, readAssignmentRows } from './lib.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const arg = (k) => { const i = process.argv.indexOf(k); const v = i > -1 ? process.argv[i + 1] : ''; return v && !v.startsWith('--') ? v : ''; };
const courseQ = arg('--course');
const titleQ = arg('--title');
const DETAIL = process.argv.includes('--detail');
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`使い方: node status.mjs [--course <科目名の一部>] [--title <課題名の一部>] [--detail]
  --course   Sakaiサイト名に部分一致（接頭辞 ['26火1] は含めない）
  --title    課題タイトルに部分一致
  --detail   提出日時・添付ファイル名まで読む（添付/本文提出/空提出を区別）
読み取り専用。ボタンは一切押さない。出力は ${DATA_DIR}/output/status.json にも書く。`);
  process.exit(0);
}
const OUT = path.join(DATA_DIR, 'output');

// 「状態」列テキストから提出済みか判定（assignments.mjs と同じ規則）
const isSubmitted = (st) => /提出日時|提出済|採点済|返却|graded|returned|submitted/i.test(st || '');
const cleanCourse = (t) => (t || '').replace(/^\['?\d+[^\]]*\]/, '').trim();

const { browser, context, page } = await getSession();
if (!(await openSakai(page))) { console.error('✗ Sakaiに入れません。`node login.mjs` を試す（→ sirius-session）'); await browser.close(); process.exit(1); }
const j = async (p) => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

// 今学期(YYYY_TT が最大)のサイトだけ対象
const sj = await j('/direct/site.json?_limit=999');
const allSites = (sj?.site_collection || []).map((s) => ({ id: s.id, title: s.title })).filter((s) => /^\d{4}_\d{2}/.test(s.id));
const curTerm = allSites.map((s) => s.id.slice(0, 7)).sort().reverse()[0];
let sites = allSites.filter((s) => s.id.startsWith(curTerm));
if (courseQ) sites = sites.filter((s) => s.title.includes(courseQ));
if (!sites.length) { console.error(`✗ 該当サイトなし（今学期 ${curTerm} / --course "${courseQ}"）`); await browser.close(); process.exit(1); }

// 課題を持つサイトだけに絞る（APIは並列）
const targets = await sitesWithAssignments(context, sites);

const rowsAll = [];
for (const site of targets) {
  // 一覧の読み取りは lib.mjs に集約（placementの選び方・待ち方の理由はそちらのコメント参照）
  const rows = await readAssignmentRows(page, context, site.id);

  for (const r of rows) {
    const [title, status] = r.cells;
    if (!title) continue;
    if (titleQ && !title.includes(titleQ)) continue;
    rowsAll.push({
      course: cleanCourse(site.title), siteId: site.id, title, status,
      // 4列 = タイトル|状態|開始日時|締切日時 / 3列 = タイトル|状態|締切日時
      open: r.cells.length >= 4 ? (r.cells[2] || '') : '', due: r.cells[r.cells.length - 1] || '',
      submitted: isSubmitted(status), href: r.href,
    });
  }
}

// --detail: 課題ページを開いて提出物の添付ファイル名まで読む（閲覧のみ）
if (DETAIL) {
  for (const r of rowsAll) {
    if (!r.href) continue;
    await page.goto(r.href, { waitUntil: 'networkidle' }).catch(() => {});
    await page.waitForTimeout(2500);
    const txt = await page.evaluate(() => {
      let t = document.body?.innerText || '';
      for (const f of document.querySelectorAll('iframe')) { try { t += '\n' + (f.contentDocument.body?.innerText || ''); } catch {} }
      return t;
    });
    // 未返却は doView_submission（「課題が提出されました：」）、返却済みは doView_grade（「提出日時<TAB>日付」）と
    // 画面が違うので、両方の書式から提出日時を拾う。行頭ラベルだけの「提出日時」に誤マッチしないよう [ \t] のみ許可。
    r.submittedAt = (txt.match(/課題が提出されました：[ \t]*([\d/]+[ \t]+[\d:]+)/) || [])[1]?.trim()
                 || (txt.match(/提出日時[ \t]+([\d/]+[ \t]+[\d:]+)/) || [])[1]?.trim() || null;
    // 添付欄（未返却=「添付」／返却済み=「提出された添付」）以降の "ファイル名 ( 129 KB; 日時 )" を拾う
    const after = txt.split(/提出された添付|\n添付\n/).slice(1).join('\n');
    r.attachments = /添付ファイルはありません/.test(after) ? []
      : [...after.matchAll(/([^\n(]+?\.[A-Za-z0-9]{1,5})\s*\(\s*([^)]*?)\)/g)].map((m) => `${m[1].trim()} (${m[2].trim()})`);
    // 添付なしでも本文テキストで提出している場合がある（空提出と区別するため拾う）
    const inline = (txt.match(/オリジナルの提出されたテキスト\n([\s\S]*?)(?:\n添付ファイルが提出されていません|\n提出された添付|$)/) || [])[1]?.trim() || '';
    r.submittedText = inline ? inline.replace(/\s+/g, ' ').slice(0, 120) : null;
    r.resubmitAllowed = /再提出できます/.test(txt);
  }
}

await saveState(context);
await browser.close();

await fs.mkdir(OUT, { recursive: true });
await fs.writeFile(path.join(OUT, 'status.json'), JSON.stringify({ term: curTerm, checkedAt: new Date().toISOString(), rows: rowsAll }, null, 2));

if (!rowsAll.length) { console.log('該当する課題が見つかりませんでした（--title の指定を緩めてみる）'); process.exit(0); }
let curCourse = '';
for (const r of rowsAll) {
  if (r.course !== curCourse) { curCourse = r.course; console.log(`\n■ ${curCourse}`); }
  console.log(`  ${r.submitted ? '✅提出済' : '⬜未提出'}  ${r.title}  〆${r.due}  _${r.status}_`);
  if (DETAIL && r.submittedAt) {
    const body = r.attachments?.length ? `添付: ${r.attachments.join(', ')}`
               : r.submittedText ? `本文提出: 「${r.submittedText}${r.submittedText.length >= 120 ? '…' : ''}」`
               : '⚠️添付も本文もなし';
    console.log(`        提出日時: ${r.submittedAt} / ${body}${r.resubmitAllowed ? ' / 再提出可' : ''}`);
  }
}
const un = rowsAll.filter((r) => !r.submitted).length;
console.log(`\n計 ${rowsAll.length}件（提出済 ${rowsAll.length - un} / 未提出 ${un}） → ${OUT}/status.json`);
