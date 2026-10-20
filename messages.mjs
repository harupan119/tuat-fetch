#!/usr/bin/env node
// messages.mjs — Sakai(LMS) の「メッセージ」ツール（サイト内の個人宛メッセージ）を差分取得する
//
//   英語科目の先生は、連絡・教材リンク・提出指示を「お知らせ」ではなく
//   メッセージで送ってくる。お知らせAPI(/direct/announcement)には出てこないので、受信箱を画面から読む。
//
//   node messages.mjs                 … 時間割にある英語科目(科目コード el)の受信箱を差分取得
//   node messages.mjs --watch         … 英語科目の授業時間帯(開始15分前〜終了30分後)だけ取得、他は即終了（launchd 30秒周期 / タスクスケジューラ 1分周期）
//                                       時間帯内でも、保存済み cookie で受信箱の件数だけを見て（ブラウザ無し・約0.3秒）
//                                       前回と同じなら exit 3（更新なし）で打ち切る。変化・cookie切れの時だけブラウザで取得
//   node messages.mjs --all           … 今学期の全サイトを対象にする
//   node messages.mjs --course Reading … サイト名の部分一致で対象を絞る
//   node messages.mjs --refetch       … 既知のメッセージも本文を取り直す
//
//   出力:
//     ~/.local/share/sirius-fetch/output/messages.json（全件＋本文）と messages.md（新しい順）
//     科目フォルダ ~/Documents/TUAT/TUAT_<学年>_<前期|後期>/<科目>/
//       メッセージ.md            … その科目の全メッセージ（新しい順・落とした資料へのリンク付き）
//       _メッセージ/<日時>_<件名>.md … 1通1ファイル
//       _メッセージ/<日時>_<資料名> … 本文中の Google Drive リンクの実体（Docs/スライドはPDF化）
//   新着があればデスクトップ通知を出す（macOS 通知センター / Windows トースト）。
//   注意: 本文を開いたメッセージは Sakai 上で既読になる（受信箱の一覧には本文が無いため）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notify } from './platform.mjs';
// lib.mjs は playwright を読み込んで重いので、--watch の事前確認を抜けてから動的に読む
const DATA_DIR = path.join(os.homedir(), '.local/share/sirius-fetch');
const LMS = 'https://lms.sirius.tuat.ac.jp';
const STATE = path.join(DATA_DIR, 'state.json');
const WATCH_CACHE = path.join(DATA_DIR, 'messages-watch.json'); // { inbox: { <siteId>: { toolId, total } } }
const EXIT_NO_UPDATE = 3;

const OUT = path.join(DATA_DIR, 'output');
const JSON_PATH = path.join(OUT, 'messages.json');
const MD_PATH = path.join(OUT, 'messages.md');
const TUAT = path.join(os.homedir(), 'Documents/TUAT');
const TIMETABLE = path.join(OUT, 'timetable.json');   // fetch.mjs が書く時間割
// 学年 = 年度 - 入学年度 + 1（科目フォルダ TUAT_<学年>_<前期|後期> を決める）。環境変数 SIRIUS_ENTRANCE_YEAR で指定
const ENTRANCE_YEAR = Number(process.env.SIRIUS_ENTRANCE_YEAR) || new Date().getFullYear();

const args = process.argv.slice(2);
const watch = args.includes('--watch');
const allSites = args.includes('--all');
const refetch = args.includes('--refetch');
const ci = args.indexOf('--course');
const courseFilter = ci >= 0 ? args[ci + 1] : null;

// 今学期の Sakai サイトid 接頭辞（4〜9月=YYYY_01, 10〜3月=YYYY_02。1〜3月は前年度の後期）
const now = new Date();
const fy = now.getMonth() < 3 ? now.getFullYear() - 1 : now.getFullYear();
const term = now.getMonth() >= 3 && now.getMonth() < 9 ? '01' : '02';
const TERM_PREFIX = `${fy}_${term}_`;
const TERM_DIR = path.join(TUAT, `TUAT_${fy - ENTRANCE_YEAR + 1}_${term === '01' ? '前期' : '後期'}`);

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// 時間割にある英語科目（科目コード 02el…）。[{ 曜限: '火1', code: '02el0000' }]
const englishCourses = (readJson(TIMETABLE)?.courses || []).filter((c) => /^\d{2}el/.test(c.code));

// ── --watch: 英語の授業時間帯だけ動く ──
// 時限の時刻（開始, 終了）。窓は開始15分前〜終了30分後（授業直後に連絡が来ることがあるため）
const PERIODS = { 1: ['08:45', '10:15'], 2: ['10:30', '12:00'], 3: ['13:00', '14:30'], 4: ['14:45', '16:15'], 5: ['16:30', '18:00'] };
const DAYS = '日月火水木金土';
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
function inEnglishClass(d = new Date()) {
  const cur = d.getHours() * 60 + d.getMinutes();
  return englishCourses.some((c) => {
    const [, day, per] = c.曜限.match(/^(.)(\d)/) || [];
    const p = PERIODS[per];
    return p && day === DAYS[d.getDay()] && cur >= toMin(p[0]) - 15 && cur <= toMin(p[1]) + 30;
  });
}
if (watch && !process.env.MESSAGES_FORCE_WINDOW && !inEnglishClass()) process.exit(0); // FORCE は試験用

// 受信箱トップ（pvtMsgHpView）の「受信済み ( N メッセージ」の N
const inboxTotal = (html) => {
  const m = html.match(/受信済み<\/a>\s*<span[^>]*>\s*\(\s*(\d+)\s*メッセージ/);
  return m ? Number(m[1]) : null;
};
const cache = readJson(WATCH_CACHE) || { inbox: {} };

// ── --watch の事前確認: ブラウザを起動せず、件数が前回と同じなら打ち切る ──
if (watch) {
  const sakaiCookies = (readJson(STATE)?.cookies || [])
    .filter((c) => 'lms.sirius.tuat.ac.jp'.endsWith(c.domain.replace(/^\./, '')))
    .map((c) => `${c.name}=${c.value}`).join('; ');
  const targets = englishCourses.map((c) => `${TERM_PREFIX}${c.code}`);
  const unchanged = targets.length > 0 && sakaiCookies && (await Promise.all(targets.map(async (id) => {
    const c = cache.inbox[id];
    if (!c) return false; // 初回は本取得で toolId と件数を覚える
    const r = await fetch(`${LMS}/portal/tool/${c.toolId}/privateMsg/pvtMsgHpView`,
      { headers: { cookie: sakaiCookies }, redirect: 'manual', signal: AbortSignal.timeout(10000) }).catch(() => null);
    // ログイン画面へのリダイレクトや件数が読めない時は「変化あり」扱いで本取得へ（そちらで再ログインする）
    return r?.status === 200 && inboxTotal(await r.text()) === c.total;
  }))).every(Boolean);
  if (unchanged) process.exit(EXIT_NO_UPDATE);
}

const { getSession, openSakai, saveState } = await import('./lib.mjs');
const { Ledger, keyDrive } = await import('./ledger.mjs');

const store = readJson(JSON_PATH) || { messages: [] };
const known = new Map(store.messages.map((m) => [m.key, { ...m, files: m.files || [] }]));

const courseName = (title) => title.replace(/^\[[^\]]*\]\s*/, '').trim();
const safe = (s) => s.replace(/[\/:*?"<>|\\]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60);
const stampOf = (m) => String(m.date).replace(/[-:]/g, '').replace('T', '_');

// 「10 6, 2026 9:22 午前」→ ISO（ローカル時刻）
function parseDate(s) {
  const m = s.match(/(\d{1,2})\s+(\d{1,2}),\s*(\d{4})\s+(\d{1,2}):(\d{2})\s*(午前|午後|AM|PM)?/i);
  if (!m) return null;
  let [, mo, d, y, h, mi, ap] = m;
  h = Number(h) % 12 + (/午後|PM/i.test(ap || '') ? 12 : 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}T${p(h)}:${mi}`;
}

const H = { headers: { Accept: 'application/json' } };
const { browser, context, page } = await getSession();
if (!(await openSakai(page))) { console.error('✗ Sakai に入れませんでした'); await browser.close(); process.exit(1); }

// 対象サイト: 既定は時間割の英語科目（時間割が無ければ el コードの全サイト）
const englishSiteIds = new Set(englishCourses.map((c) => `${TERM_PREFIX}${c.code}`));
const sites = ((await (await context.request.get(`${LMS}/direct/site.json?_limit=200`, H)).json()).site_collection || [])
  .filter((s) => s.id.startsWith(TERM_PREFIX))
  .filter((s) => allSites || courseFilter
    || (englishSiteIds.size ? englishSiteIds.has(s.id) : /^\d{4}_\d{2}_\d{2}el/.test(s.id)))
  .filter((s) => !courseFilter || s.title.includes(courseFilter));

const fresh = [];
for (const site of sites) {
  const pages = await (await context.request.get(`${LMS}/direct/site/${site.id}/pages.json`, H)).json().catch(() => []);
  const tool = pages.flatMap((p) => p.tools || []).find((t) => t.toolId === 'sakai.messages');
  if (!tool) continue;
  const course = courseName(site.title);
  const openInbox = async () => {
    await page.goto(`${LMS}/portal/tool/${tool.id}/privateMsg/pvtMsgHpView`, { waitUntil: 'domcontentloaded' });
    const total = inboxTotal(await page.content());
    if (total !== null) cache.inbox[site.id] = { toolId: tool.id, total };
    await page.getByText('受信済み').first().click();
    await page.waitForSelector('text=Showing page', { timeout: 15000 }).catch(() => {});
  };
  await openInbox();
  // 受信箱の行: 件名リンク・日時・執筆者・未読フラグ
  const rows = await page.evaluate(() => [...document.querySelectorAll('tr')].map((tr) => {
    const a = [...tr.querySelectorAll('td a')].find((x) => x.innerText.trim() && !/フォルダ|メッセージ$/.test(x.innerText));
    if (!a) return null;
    const cells = [...tr.querySelectorAll('td')].map((td) => td.innerText.trim()).filter(Boolean);
    const subject = a.innerText.replace(/\(未読\)/, '').trim();
    const idx = cells.findIndex((c) => c.includes(subject));
    return { subject, date: cells[idx + 1] || '', author: cells[idx + 2] || '', unread: /\(未読\)/.test(a.innerText) };
  }).filter(Boolean));

  for (const r of rows) {
    const key = `${site.id}|${r.date}|${r.author}|${r.subject}`;
    if (known.has(key) && !refetch) continue;
    await openInbox();
    await page.getByRole('link', { name: r.subject }).first().click();
    await page.waitForSelector('text=件名', { timeout: 15000 }).catch(() => {});
    // 本文は「ラベル」行より後ろ。ヘッダ（執筆者・宛先など）はそれより前
    const text = await page.innerText('body');
    const body = text.split(/\nラベル\t[^\n]*\n/)[1]?.trim() ?? text;
    const atts = await page.locator('a').evaluateAll((as) => as.map((a) => ({ name: a.innerText.trim(), url: a.href }))
      .filter((x) => /\/access\/content\/attachment\//.test(x.url)));
    const msg = { key, siteId: site.id, course, subject: r.subject, author: r.author, date: parseDate(r.date) || r.date,
      body, attachments: atts, files: known.get(key)?.files || [], fetchedAt: new Date().toISOString() };
    known.set(key, msg);
    fresh.push(msg);
  }
}

// ── 添付（Sakai）を落とす。Sakai の cookie が要るのでブラウザを閉じる前に ──
const ledger = new Ledger();
const msgDir = (m) => path.join(TERM_DIR, m.course, '_メッセージ');
const hasCourseDir = (m) => fs.existsSync(path.join(TERM_DIR, m.course));
for (const m of known.values()) {
  if (!hasCourseDir(m)) continue;
  for (const a of m.attachments || []) {
    const key = `sakai-msg:${a.url}`;
    if (ledger.has(key)) continue;
    const r = await context.request.get(a.url);
    if (!r.ok()) { console.log(`  ✗ 添付 ${a.name}: HTTP ${r.status()}`); continue; }
    const out = path.join(msgDir(m), `${stampOf(m)}_${safe(a.name)}`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, await r.body());
    ledger.record(key, { status: 'done', dest: out, source: 'sakai-message' });
    m.files.push({ name: a.name, path: out });
    console.log(`  ↓ ${path.basename(out)}`);
  }
}
await saveState(context);
await browser.close();
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.writeFileSync(WATCH_CACHE, JSON.stringify(cache, null, 2));

// ── 本文中の Google Drive リンクを落とす（Classroom 用の Drive API トークンを使う） ──
const DRIVE_ID = /(?:drive|docs)\.google\.com\/(?:file\/d\/|document\/d\/|presentation\/d\/|spreadsheets\/d\/|open\?id=|uc\?id=)([\w-]{20,})/g;
const EXPORT = {
  'application/vnd.google-apps.document': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.presentation': { mime: 'application/pdf', ext: '.pdf' },
  'application/vnd.google-apps.spreadsheet': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: '.xlsx' },
};
const driveTargets = [...known.values()].filter(hasCourseDir)
  .flatMap((m) => [...m.body.matchAll(DRIVE_ID)].map((x) => ({ m, id: x[1] })))
  .filter(({ id }) => !ledger.has(keyDrive(id)));
if (driveTargets.length) {
  let drive = null;
  try {
    const { authorized, driveApi } = await import('./classroom/api.mjs');
    drive = driveApi(authorized());
  } catch (e) { console.log(`  ✗ Drive API を使えません: ${e.message}`); }
  for (const { m, id } of drive ? driveTargets : []) {
    try {
      const meta = (await drive.files.get({ fileId: id, fields: 'id,name,mimeType', supportsAllDrives: true })).data;
      const exp = EXPORT[meta.mimeType];
      if (!exp && meta.mimeType.startsWith('application/vnd.google-apps.')) continue; // フォーム等は落とせない
      const res = exp
        ? await drive.files.export({ fileId: id, mimeType: exp.mime }, { responseType: 'arraybuffer' })
        : await drive.files.get({ fileId: id, alt: 'media', supportsAllDrives: true }, { responseType: 'arraybuffer' });
      let name = safe(meta.name);
      if (exp && !name.toLowerCase().endsWith(exp.ext)) name += exp.ext;
      const out = path.join(msgDir(m), `${stampOf(m)}_${name}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(res.data));
      ledger.record(keyDrive(id), { status: 'done', dest: out, source: 'sakai-message-drive' });
      m.files.push({ name: meta.name, path: out, url: `https://drive.google.com/file/d/${id}/view` });
      console.log(`  ↓ ${path.basename(out)}`);
    } catch (e) {
      console.log(`  ✗ Drive ${id}: ${String(e?.errors?.[0]?.message || e.message).slice(0, 120)}`);
    }
  }
}
ledger.save();

// ── 保存 ──
const all = [...known.values()].sort((a, b) => String(b.date).localeCompare(String(a.date)));
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(JSON_PATH, JSON.stringify({ updatedAt: new Date().toISOString(), messages: all }, null, 2));

// fromDir: 資料リンクを相対パスで書く基準（output/ の一覧では絶対パス）
const render = (m, fromDir) => [
  `## ${m.subject}`, '',
  `- 科目: ${m.course}`, `- 差出人: ${m.author}`, `- 日時: ${m.date.replace('T', ' ')}`,
  ...(m.files || []).map((f) => `- 資料: [${f.name}](<${fromDir ? path.relative(fromDir, f.path) : f.path}>)`),
  '',
  m.body, '',
].join('\n');
const updated = `更新: ${new Date().toLocaleString('ja-JP')}`;
fs.writeFileSync(MD_PATH, `# Sakai メッセージ（新しい順）\n\n${updated}\n\n${all.map((m) => render(m)).join('\n')}`);

// 科目ごと: メッセージ.md（一覧）と _メッセージ/ の1通1ファイル
for (const course of new Set(all.map((m) => m.course))) {
  const dir = path.join(TERM_DIR, course);
  if (!fs.existsSync(dir)) continue; // 科目フォルダが無ければ output/ のみ
  const ms = all.filter((m) => m.course === course);
  fs.writeFileSync(path.join(dir, 'メッセージ.md'),
    `# ${course} — Sakai メッセージ（新しい順）\n\n${updated}\n\n${ms.map((m) => render(m, dir)).join('\n')}`);
  const mdir = path.join(dir, '_メッセージ');
  fs.mkdirSync(mdir, { recursive: true });
  for (const m of ms) {
    fs.writeFileSync(path.join(mdir, `${stampOf(m)}_${safe(m.subject)}.md`),
      `# ${m.subject}\n\n${render(m, mdir).split('\n').slice(2).join('\n')}`);
  }
}

console.log(`対象 ${sites.length} サイト / 新着 ${fresh.length} 件 / 累計 ${all.length} 件 → ${MD_PATH}`);
for (const m of fresh) console.log(`  ✉ [${m.course}] ${m.date.replace('T', ' ')} ${m.subject}（${m.author}）`);

// 通知: クリックで科目の メッセージ.md を開く（macOS は terminal-notifier がある時のみ。詳細は platform.mjs）
for (const course of new Set(fresh.map((m) => m.course))) {
  const ms = fresh.filter((m) => m.course === course);
  const title = `${course} 新着${ms.length}件`;
  const subtitle = ms.map((m) => m.subject).join(' / ');
  const text = ms[0].body.replace(/\s+/g, ' ').slice(0, 120); // 先頭の本文をプレビューに
  const index = path.join(TERM_DIR, course, 'メッセージ.md');
  const target = fs.existsSync(index) ? index : MD_PATH;
  notify({ title, subtitle, message: text, open: target, group: `sakai-msg-${course}` });
}
