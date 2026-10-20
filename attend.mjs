// attend.mjs — Sakai(SIRIUS-LMS)の「テスト・クイズ」型の出席（第N回出席 等）を半自動で登録する。
//   TUATの出席はSakaiのテスト・クイズ(samigo)に「第N回出席」「第N回 出席確認」として出される。
//   受験可能な出席クイズを探して開くところまでを自動化し、
//   既定では最終の「提出」は本人が押す（誤提出防止。--go 指定時のみ全自動）。
//
//   使い方:
//     node attend.mjs --list                       # 受験可能な出席クイズを一覧（読み取りのみ）
//     node attend.mjs --history                    # 提出済みの出席履歴を科目別に一覧（全科目・読み取りのみ）
//     node attend.mjs --notify                     # 受験可能な出席クイズがあればmacOS通知（watch用・読み取りのみ）
//     node attend.mjs                              # 候補が1件なら headed で受験画面を開く（開始は押さない）
//     node attend.mjs --course "知的財産"           # 科目名（部分一致）で絞る
//     node attend.mjs --code 1234                  # 開始→コード入力まで自動。提出は本人が押す
//     node attend.mjs --code 1234 --go             # 提出まで全自動（実験的。初回は --go なしで挙動確認を推奨）
//   オプション:
//     --title "第13回"   クイズタイトルの部分一致（同一科目に複数候補があるとき）
//     --all             今日の曜日以外の科目も候補に含める
//     --choice N        選択式のとき N番目(1始まり)の選択肢を選ぶ。選択肢が1個だけなら --go で自動選択
//   watch(launchd)運用: 環境変数 SIRIUS_WATCH=1 のとき平日 8:00-18:30 以外は何もせず終了。
//   通知の重複防止は ~/.local/share/sirius-fetch/attend-state.json に記録。
import { launch, openSakai, saveState, LMS, DATA_DIR } from './lib.mjs';
import path from 'node:path';
import fs from 'node:fs';
import { notify } from './platform.mjs';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const listOnly = args.includes('--list');
const historyMode = args.includes('--history');
const notifyMode = args.includes('--notify');
const go = args.includes('--go');
const allDays = args.includes('--all');
const courseQ = opt('--course') || '';
const titleQ = opt('--title') || '';
const code = opt('--code');
const choice = opt('--choice');
const readOnly = listOnly || historyMode || notifyMode;

// watch(launchd)からの起動時は授業がありうる時間帯だけ動く（無駄なポーリング抑制）
if (process.env.SIRIUS_WATCH === '1') {
  const d = new Date(), wd = d.getDay(), hm = d.getHours() * 60 + d.getMinutes();
  if (wd === 0 || wd === 6 || hm < 8 * 60 || hm > 18 * 60 + 30) process.exit(0);
}

const ATT_RE = /出席|出欠/;
const shot = (page, name) => page.screenshot({ path: path.join(DATA_DIR, 'inspect', `attend-${name}.png`), fullPage: true }).catch(() => {});

// 読み取り系(--list/--history/--notify)は headless、実際に開くときは headed
const { browser, context, page } = await launch({ headless: readOnly });
if (!(await openSakai(page))) { console.error('✗ Sakaiに入れません（sirius-session で再ログイン）'); await browser.close(); process.exit(1); }

const j = async (p) => { const r = await context.request.get(LMS + p, { headers: { Accept: 'application/json' } }); return r.ok() ? r.json() : null; };

// ── 今学期のサイト一覧 ──
const sj = await j('/direct/site.json?_limit=999');
let sites = (sj?.site_collection || []).map((s) => ({ id: s.id, title: s.title })).filter((s) => /^\d{4}_\d{2}/.test(s.id));
const curTerm = sites.map((s) => s.id.slice(0, 7)).sort().reverse()[0];
sites = sites.filter((s) => s.id.startsWith(curTerm));
if (courseQ) sites = sites.filter((s) => s.title.includes(courseQ));

// 今日の曜日の科目を優先（サイト名 ['26月4]... の曜日文字で判定）。--history は全科目が既定
const youbi = '日月火水木金土'[new Date().getDay()];
if (!courseQ && !allDays && !historyMode) {
  const todays = sites.filter((s) => (s.title.match(/^\['\d\d(.)/) || [])[1] === youbi);
  if (todays.length) sites = todays;
  else console.log(`▶ 今日(${youbi})の科目にサイトが無いため全科目を走査（--all 相当）`);
}
console.log(`▶ 走査対象: ${sites.map((s) => s.title).join(' / ') || '(なし)'}`);

// ── 各サイトのテスト一覧を HTTP で確認し、受験可能(takeAssessment)な出席クイズを収集 ──
// ブラウザでページを開くのは対象が確定した1サイトだけ（高速化）。
// 受験可能リンクは onclick に selectIndexForm:...:takeAssessment を持つ。提出済みには無い。
// samigo一覧はJSFのサーバサイドレンダリング。ツールの配置ID直指定でHTMLを1発GETできる
// （pages.json の url はホームページ共用のことがあり、iframe特定が不確実なため使わない）。
const candidates = [];
const history = []; // { site, quiz, date } 提出済みの出席（最新提出日時）
for (const site of sites) {
  const pages = await j(`/direct/site/${site.id}/pages.json`);
  const samigo = (pages || []).flatMap((p) => p.tools || []).find((t) => t.toolId === 'sakai.samigo');
  if (!samigo) continue;
  const r = await context.request.get(`${LMS}/portal/tool/${samigo.id}/jsf/index/mainIndex`).catch(() => null);
  const html = r?.ok() ? await r.text() : '';
  if (!html.includes('selectIndexForm')) continue; // テスト一覧に到達できていない（ツール未設置等）
  // 受験可能＝「テストを受験」テーブル(selectTable)内の takeAssessment リンクのみ
  for (const m of html.matchAll(/<a[^>]*selectTable[^>]*takeAssessment[^>]*>([\s\S]*?)<\/a>/g)) {
    const t = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    if (t && ATT_RE.test(t)) candidates.push({ site, toolUrl: samigo.url, quiz: t });
  }
  // 提出済み＝reviewTable。行構造は「タイトル行」→「提出日時行(末尾セルに日時)」のペア
  const rt = html.match(/<table[^>]*id="selectIndexForm:reviewTable"[^>]*>([\s\S]*?)<\/table>/);
  if (rt) {
    let lastTitle = null;
    for (const row of rt[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
        .map((c) => c[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
      if (!cells.length || cells[0] === 'タイトル') continue;
      if (cells[0]) lastTitle = cells[0];
      const dm = cells.join(' ').match(/\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}/);
      if (dm && lastTitle && ATT_RE.test(lastTitle) && !history.some((h) => h.site === site && h.quiz === lastTitle)) {
        history.push({ site, quiz: lastTitle, date: dm[0] });
      }
    }
  }
}

// ── 出席状況サマリを書き出し（reminder-daily.mjs がデイリーノートに反映する） ──
const OUT_DIR = path.join(DATA_DIR, 'output');
fs.mkdirSync(OUT_DIR, { recursive: true });
{
  const byCourse = new Map();
  for (const h of history) { const k = h.site.title; byCourse.set(k, (byCourse.get(k) || 0) + 1); }
  const lines = [`# 出席状況 (更新 ${new Date().toLocaleString('sv-SE').slice(0, 16)})`];
  for (const c of candidates) lines.push(`- ⏰ 受験可能: [${c.site.title}] ${c.quiz}`);
  for (const [course, n] of byCourse) lines.push(`- ${course}: ${n}回提出済み`);
  fs.writeFileSync(path.join(OUT_DIR, 'attendance.md'), lines.join('\n') + '\n');
}

// ── --history: 科目別の出席履歴を表示して終了 ──
if (historyMode) {
  const byCourse = new Map();
  for (const h of history) { const k = h.site.title; if (!byCourse.has(k)) byCourse.set(k, []); byCourse.get(k).push(h); }
  if (!byCourse.size && !candidates.length) console.log('✗ 出席系クイズの記録はありません。');
  for (const [course, hs] of byCourse) {
    console.log(`■ ${course}（${hs.length}回提出済み）`);
    for (const h of hs) console.log(`   ✓ ${h.quiz}  ${h.date}`);
  }
  for (const c of candidates) console.log(`■ ${c.site.title} ⏰ 受験可能（未提出）: ${c.quiz}`);
  await saveState(context); await browser.close(); process.exit(0);
}

// ── --notify: 新規の受験可能クイズがあればデスクトップ通知して終了（重複通知しない） ──
if (notifyMode) {
  const stateFile = path.join(DATA_DIR, 'attend-state.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
  st.notified ||= {};
  const fresh = candidates.filter((c) => !st.notified[`${c.site.id}::${c.quiz}`]);
  for (const c of fresh) {
    const msg = `${c.quiz} が受験可能です`;
    notify({ title: 'SIRIUS出席', subtitle: c.site.title, message: msg });
    st.notified[`${c.site.id}::${c.quiz}`] = new Date().toISOString();
    console.log(`▶ 通知: [${c.site.title}] ${c.quiz}`);
  }
  if (!fresh.length) console.log(candidates.length ? '▶ 受験可能クイズあり（通知済みのため再通知なし）' : '▶ 受験可能な出席クイズなし');
  fs.writeFileSync(stateFile, JSON.stringify(st, null, 1));
  await saveState(context); await browser.close(); process.exit(0);
}

if (!candidates.length) {
  console.log('✗ 受験可能な出席クイズはありません（未公開・提出済み・対象科目なし）。--all や --course も試してください。');
  await saveState(context); await browser.close(); process.exit(0);
}
console.log('▶ 受験可能な出席クイズ:');
for (const c of candidates) console.log(`   - [${c.site.title}] ${c.quiz}`);
if (listOnly) { await saveState(context); await browser.close(); process.exit(0); }

// ── 対象を1件に絞る ──
let targets = titleQ ? candidates.filter((c) => c.quiz.includes(titleQ)) : candidates;
if (targets.length !== 1) {
  console.error(`✗ 候補が${targets.length}件です。--course / --title で1件に絞ってください。`);
  await saveState(context); await browser.close(); process.exit(1);
}
const target = targets[0];
console.log(`▶ 対象: [${target.site.title}] ${target.quiz}`);

// ── クイズを開く（iframe内のリンクをクリック → 受験開始ページ） ──
await page.goto(target.toolUrl, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const frame = page.frames().find((f) => f.url().includes('/jsf/')) ||
              page.frames().find((f) => f !== page.mainFrame());
const scope = frame || page;
await scope.locator(`a[onclick*="takeAssessment"]`, { hasText: target.quiz }).first().click();
await page.waitForTimeout(2500);
await shot(page, '1-begin');

// IP制限の検知（教員が学内ネットワーク限定に設定しているクイズがある）
const ipDenied = async () => {
  const t = await scope.locator('body').innerText().catch(() => '');
  return /アクセスが拒否されました|IP\s*アドレス.*アクセス権/s.test(t);
};
if (await ipDenied()) {
  console.error('✗ IP制限で拒否されました。このクイズは学内ネットワーク限定です。');
  console.error('  学内Wi-Fi (TUAT-WiFi / eduroam) に接続して再実行してください（テザリング・VPNは不可）。');
  await saveState(context); await browser.close(); process.exit(3);
}

// 受験開始ページ（「テスト受験を開始」ボタン）。--code も --go も無ければここで本人に委ねる。
const beginBtn = scope.locator('input[type=submit][value*="開始"], button:has-text("開始")').first();
if (!code && !go) {
  console.log('▶ 受験画面を開きました。ブラウザで「開始」→ 回答 → 提出 を本人が行ってください（最大15分でブラウザを閉じます）。');
  await saveState(context);
  await page.waitForTimeout(15 * 60 * 1000).catch(() => {});
  await browser.close(); process.exit(0);
}

// ── --code / --go あり: 開始 → （コードがあれば）入力 ──
if (await beginBtn.count()) { await beginBtn.click(); await page.waitForTimeout(2500); }
await shot(page, '2-delivery');
if (await ipDenied()) {
  console.error('✗ IP制限で拒否されました（開始時）。学内Wi-Fiに接続して再実行してください。');
  await saveState(context); await browser.close(); process.exit(3);
}
const inputs = scope.locator('input[type=text]:visible, textarea:visible');
const n = await inputs.count();
let needHuman = false;
if (n === 0) {
  console.log('▶ テキスト入力欄はありません。');
} else if (code) {
  await inputs.first().fill(code);
  console.log(`▶ コード "${code}" を入力しました${n > 1 ? `（入力欄が${n}個あるため先頭のみ。他はブラウザで確認）` : ''}。`);
} else {
  // 入力欄があるのにコード未指定 → 自動提出すると空回答になるため必ず本人に委ねる
  needHuman = true;
  console.log('△ 入力欄があるのに --code がありません。空のまま提出すると欠席扱いの恐れがあるため、ブラウザで本人が回答・提出してください。');
}
// 選択式（ラジオボタン）: --choice N で選択。選択肢1個なら --go で自動選択
const radios = scope.locator('input[type=radio]:visible');
const rn = await radios.count();
if (rn > 0) {
  const labels = [];
  for (let i = 0; i < rn; i++) {
    const id = await radios.nth(i).getAttribute('id');
    const lb = id ? await scope.locator(`label[for="${id}"]`).innerText().catch(() => '') : '';
    labels.push((lb || `選択肢${i + 1}`).replace(/\s+/g, ' ').trim());
  }
  console.log(`▶ 選択式: ${labels.map((l, i) => `${i + 1}.${l}`).join(' / ')}`);
  if (choice) {
    const idx = parseInt(choice, 10) - 1;
    if (idx >= 0 && idx < rn) { await radios.nth(idx).check(); console.log(`▶ ${choice}番目「${labels[idx]}」を選択しました。`); }
    else { needHuman = true; console.log(`△ --choice ${choice} が範囲外です（1〜${rn}）。ブラウザで本人が選択してください。`); }
  } else if (rn === 1 && go) {
    await radios.first().check();
    console.log(`▶ 選択肢が1個だけなので「${labels[0]}」を自動選択しました。`);
  } else {
    needHuman = true;
    console.log('△ 選択肢が複数あり --choice 未指定のため、ブラウザで本人が選択・提出してください。');
  }
}
await shot(page, '3-filled');

if (!go || needHuman) {
  console.log('▶ 提出は本人がブラウザで押してください（「採点のために提出」→ 確認。最大15分でブラウザを閉じます）。');
  await saveState(context);
  await page.waitForTimeout(15 * 60 * 1000).catch(() => {});
  await browser.close(); process.exit(0);
}

// ── --go: 提出まで自動（実験的） ──
const submitBtn = scope.locator('input[type=submit][value*="採点のために提出"], input[type=submit][value*="提出"], button:has-text("提出")').first();
if (!(await submitBtn.count())) { console.error('✗ 提出ボタンが見つかりません。ブラウザで本人が提出してください。'); await page.waitForTimeout(15 * 60 * 1000).catch(() => {}); await browser.close(); process.exit(1); }
await submitBtn.click(); await page.waitForTimeout(2000);
await shot(page, '4-confirm');
// 確認ページの最終「提出」
const confirmBtn = scope.locator('input[type=submit][value*="提出"], button:has-text("提出")').first();
if (await confirmBtn.count()) { await confirmBtn.click(); await page.waitForTimeout(2500); }
await shot(page, '5-done');
const bodyText = await scope.locator('body').innerText().catch(() => '');
if (/提出.*(受理|完了|しました)|送信され/.test(bodyText)) console.log('✓ 提出完了の表示を確認しました。');
else console.log('△ 完了表示を確認できませんでした。inspect/attend-5-done.png とブラウザで確認してください。');
// 完了ページの「続ける」まで押して一覧に戻る（提出済みに載ったことも確認）
const contBtn = scope.locator('input[type=submit][value*="続ける"], button:has-text("続ける"), a:has-text("続ける")').first();
if (await contBtn.count()) {
  await contBtn.click();
  await page.waitForTimeout(2000);
  await shot(page, '6-list');
  const listText = await scope.locator('body').innerText().catch(() => '');
  if (listText.includes(target.quiz)) console.log(`✓ 「続ける」で一覧に戻りました（${target.quiz} を確認）。`);
  else console.log('▶ 「続ける」を押して一覧に戻りました。');
}
await saveState(context);
await page.waitForTimeout(60 * 1000).catch(() => {});
await browser.close();
