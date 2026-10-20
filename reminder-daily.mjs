// reminder-daily.mjs — Sakai/Classroomの未提出課題を、日付ごとのリマインドファイル（.md か .txt）に書き出す
//   （sirius-reminder スキル・fetch-all から利用）。特定のノートアプリは前提にしない。
//   元データ: ~/.local/share/sirius-fetch/output/{assignments-todo.md, classroom-todo.md}
//     （無ければ assignments.mjs / classroom/fetch.mjs を先に実行しておく）
//
//   出力: <SIRIUS_REMINDER_DIR>/<YYYY-MM-DD>.<md|txt>
//     SIRIUS_REMINDER_DIR    … 出力先（既定 ~/Documents/TUAT/_リマインド）
//     SIRIUS_REMINDER_FORMAT … md（既定）/ txt
//     SIRIUS_REMINDER_AFTER  … 既存ファイルに課題の節が無い時、この見出しの節の直後に入れる（無ければ末尾）
//   ファイルが無ければ作る。あれば課題の節（md: 「## 📚 課題」/ txt: 「【課題】」）だけを置き換え、他の内容は残す。
//   なので、出力先を手持ちのノート（日付名の .md）のフォルダにしても壊さない。
//
//   node reminder-daily.mjs              # 今日の分
//   node reminder-daily.mjs 2026-06-25   # 日付指定
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const OUT = path.join(HOME, '.local/share/sirius-fetch/output');
// SIRIUS_DIARY_DIR / SIRIUS_DIARY_AFTER は旧版の名前（互換のため読む）
const DIR = process.env.SIRIUS_REMINDER_DIR || process.env.SIRIUS_DIARY_DIR || path.join(HOME, 'Documents/TUAT/_リマインド');
const FORMAT = (process.env.SIRIUS_REMINDER_FORMAT || 'md').toLowerCase() === 'txt' ? 'txt' : 'md';
const AFTER = process.env.SIRIUS_REMINDER_AFTER || process.env.SIRIUS_DIARY_AFTER || '';

const arg = process.argv.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
const today = arg || new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD (ローカル)
const file = path.join(DIR, `${today}.${FORMAT}`);

// 形式ごとの書き方。isHead は「節の見出し」とみなす行（課題の節はここまでで終わる）
const F = FORMAT === 'md'
  ? {
      head: '## 📚 課題', isHead: (l) => /^## /.test(l), title: `# ${today} 課題リマインド`,
      item: (it) => `- [ ] ${it.text}  ｜${it.source}${it.url ? ` [開く](${it.url})` : ''}`,
      att: (ls) => `\n### 🪑 出席\n${ls.join('\n')}`,
    }
  : {
      head: '【課題】', isHead: (l) => /^【/.test(l), title: `${today} 課題リマインド`,
      // 元の todo は Markdown なので、強調（**…** / _…_）の記号を外して素の文字にする
      item: (it) => `・${it.text.replace(/\*\*/g, '').replace(/(^|\s)_([^_]+)_(?=\s|$)/g, '$1$2')}  ｜${it.source}${it.url ? ` ${it.url}` : ''}`,
      att: (ls) => `\n（出席）\n${ls.map((l) => l.replace(/^- /, '・')).join('\n')}`,
    };

// --- 未提出課題を todo md から抽出 ---
function parseTodos(f, source) {
  if (!fs.existsSync(f)) return [];
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^- \[ \] (.+)$/);
    if (!m) continue;
    // 直後のインデント行に URL があれば拾う（Classroom）
    const url = (lines[i + 1] || '').trim().match(/^https?:\/\/\S+/);
    out.push({ text: m[1].trim(), source, url: url ? url[0] : null });
  }
  return out;
}

// 課題ではない/追跡不要なものを除外（部分一致）。希望制の募集フォーム等。
//   環境変数 SIRIUS_IGNORE_KEYWORDS にカンマ区切りで指定（例: "募集,アンケート"）。
const IGNORE = (process.env.SIRIUS_IGNORE_KEYWORDS || '').split(',').map((s) => s.trim()).filter(Boolean);
const items = [
  ...parseTodos(path.join(OUT, 'assignments-todo.md'), 'Sakai'),
  ...parseTodos(path.join(OUT, 'classroom-todo.md'), 'Classroom'),
].filter((it) => !IGNORE.some((kw) => it.text.includes(kw)));

const now = new Date().toLocaleTimeString('ja-JP', { hour12: false });
const body = items.length ? items.map(F.item).join('\n') : '(未提出なし)';

// 出席状況（attend.mjs --list/--history/--notify が書き出すサマリ。当日更新分のみ反映）
let attBlock = '';
const attFile = path.join(OUT, 'attendance.md');
if (fs.existsSync(attFile)) {
  const mtimeDay = new Date(fs.statSync(attFile).mtimeMs).toLocaleDateString('sv-SE');
  if (mtimeDay === today) {
    const attLines = fs.readFileSync(attFile, 'utf8').split('\n').filter((l) => l.startsWith('- '));
    if (attLines.length) attBlock = F.att(attLines);
  }
}
const sectionLines = `${F.head} (同期済み ${now})\n${body}${attBlock}`.split('\n');

let lines;
if (!fs.existsSync(file)) {
  fs.mkdirSync(DIR, { recursive: true });
  lines = [F.title, '', ...sectionLines, ''];
} else {
  lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.startsWith(F.head));
  if (startIdx !== -1) {
    // 既存の課題の節を、次の見出しの直前まで置換（行ベースで確実に）
    let end = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) { if (F.isHead(lines[i])) { end = i; break; } }
    const tail = lines.slice(end);
    lines = [...lines.slice(0, startIdx), ...sectionLines, ...(tail.length ? [''] : []), ...tail];
  } else {
    // AFTER の見出しがあれば、その節の直後（次の見出しの直前）に挿入。無ければ末尾
    const afterIdx = AFTER ? lines.findIndex((l) => l.startsWith(AFTER)) : -1;
    let insertAt = -1;
    if (afterIdx !== -1) for (let i = afterIdx + 1; i < lines.length; i++) { if (F.isHead(lines[i])) { insertAt = i; break; } }
    if (insertAt === -1) lines = [...lines, '', ...sectionLines];
    else lines = [...lines.slice(0, insertAt), ...sectionLines, '', ...lines.slice(insertAt)];
  }
}
fs.writeFileSync(file, lines.join('\n'));
console.log(`✓ ${file} の「${F.head}」を更新（未提出 ${items.length}件）`);
