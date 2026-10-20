// gate.mjs — Classroom 課題に添付する前の「提出ゲート」。
//   課題説明文（API）とローカルのファイルを突き合わせ、誤提出を添付前に止める。
//   使い方: node classroom/gate.mjs "<課題URL>" "<ファイルパス>"
//     単体で呼ぶと判定だけ行う（添付しない）。attach.mjs は添付前に必ずこれを通す。
//
//   判定（NG が1つでもあれば通さない。WARN/SKIP は通す）:
//     1 ファイル名  説明文の「ファイル名は「…」とすること」と完全一致するか
//     2 回番号      フォルダ名(01/)・ファイル名・課題名(第1回)の回番号が一致するか
//     3 本文        PDF の文字情報に学籍番号と氏名があるか
//     4 形式        説明文が PDF を求めるなら、拡張子と中身が PDF か
//     5 期限・状態  期限前か、まだ提出済みでないか
//     6 配布資料    教材の台帳(ledger.json)に載っているファイルではないか
//
//   本人情報: ~/.local/share/sirius-fetch/identity.json  {"studentId": "...", "name": "..."}
//   終了コード: 0 = 通過  1 = 未設定  2 = 認証切れ  3 = NG
import { google } from 'googleapis';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authorized, bailOnAuthError } from './api.mjs';
import { Ledger } from '../ledger.mjs';

const DATA = path.join(os.homedir(), '.local/share/sirius-fetch');
export const IDENTITY_PATH = path.join(DATA, 'identity.json');

export function loadIdentity() {
  try {
    const id = JSON.parse(fs.readFileSync(IDENTITY_PATH, 'utf8'));
    if (id.studentId && id.name) return id;
  } catch {}
  console.error(`✗ 本人情報がありません: ${IDENTITY_PATH}`);
  console.error('  {"studentId": "学籍番号", "name": "氏名"} を書いてください。');
  process.exit(1);
}

// 課題URL（/c/<course>/a/<work>/）から数値IDを取り出す。URL内のIDは base64 のことがある。
export function parseAssignmentUrl(url) {
  const m = url.match(/\/c\/([^/]+)\/a\/([^/?#]+)/);
  if (!m) throw new Error(`課題URLの形式ではありません: ${url}`);
  const dec = (s) => (/^\d+$/.test(s) ? s : Buffer.from(s, 'base64').toString('utf8'));
  return { courseId: dec(m[1]), courseWorkId: dec(m[2]) };
}

// 説明文から「ファイル名は「…」」の指定を取り出す
export function namingTemplate(description = '') {
  const m = description.match(/ファイル名[はを]?\s*[「『]([^」』]+)[」』]/);
  return m ? m[1].trim() : null;
}

export function expectedName(template, { studentId, name }) {
  return template.replace(/学籍番号/g, studentId).replace(/氏名|名前/g, name);
}

// 文字列から回番号を拾う（第1回 / 第2026-01回 / 08回 / 先頭の 01_ / 01-1_）
export function roundOf(s) {
  if (!s) return null;
  const m = s.match(/第\s*(?:\d{4}-)?0*(\d{1,2})\s*回/) || s.match(/(?:^|\D)0*(\d{1,2})\s*回/) || s.match(/^0*(\d{1,2})(?=[_-])/);
  return m ? Number(m[1]) : null;
}

const norm = (s) => s.normalize('NFKC').replace(/\s+/g, '');

function pdfText(file) {
  try { return execFileSync('pdftotext', ['-q', file, '-'], { encoding: 'utf8', maxBuffer: 64 << 20 }); }
  catch { return null; }
}

export async function runGate(url, file, { identity = loadIdentity() } = {}) {
  const { courseId, courseWorkId } = parseAssignmentUrl(url);
  const c = google.classroom({ version: 'v1', auth: authorized() });
  let work, sub;
  try {
    work = (await c.courses.courseWork.get({ courseId, id: courseWorkId })).data;
    const subs = (await c.courses.courseWork.studentSubmissions.list({ courseId, courseWorkId })).data.studentSubmissions || [];
    sub = subs[0];
  } catch (e) { bailOnAuthError(e); throw e; }

  const desc = work.description || '';
  const base = path.basename(file);
  const results = [];
  const add = (no, label, status, detail) => results.push({ no, label, status, detail });

  // 1 ファイル名
  const tpl = namingTemplate(desc);
  const want = tpl ? expectedName(tpl, identity) : null;
  if (!tpl) add(1, 'ファイル名', 'SKIP', '説明文にファイル名の指定なし');
  else if (base.normalize('NFC') === want.normalize('NFC')) add(1, 'ファイル名', 'PASS', want);
  else add(1, 'ファイル名', 'NG', `「${want}」にする（今は「${base}」）`);

  // 2 回番号
  const rounds = {
    フォルダ: /^\d{1,2}$/.test(path.basename(path.dirname(path.resolve(file)))) ? Number(path.basename(path.dirname(path.resolve(file)))) : null,
    ファイル名: roundOf(base),
    課題名: roundOf(work.title),
  };
  const found = Object.entries(rounds).filter(([, v]) => v != null);
  const show = found.map(([k, v]) => `${k}=${v}`).join(' ');
  if (found.length < 2) add(2, '回番号', 'SKIP', `比べられる回番号が足りない（${show || 'なし'}）`);
  else if (new Set(found.map(([, v]) => v)).size === 1) add(2, '回番号', 'PASS', show);
  else add(2, '回番号', 'NG', `食い違い: ${show}`);

  // 3 本文
  const isPdf = fs.readFileSync(file).subarray(0, 5).toString('latin1') === '%PDF-';
  const text = isPdf ? pdfText(file) : null;
  if (!isPdf) add(3, '本文', 'SKIP', 'PDF でないので本文は見ない');
  else if (!text || !norm(text)) add(3, '本文', 'WARN', '文字情報が無く確かめられない。表紙の学籍番号・氏名を目で確認する');
  else {
    const t = norm(text);
    const miss = [['学籍番号', identity.studentId], ['氏名', identity.name]].filter(([, v]) => !t.includes(norm(v))).map(([k]) => k);
    if (miss.length) add(3, '本文', 'NG', `本文に ${miss.join('・')} が見つからない`);
    else add(3, '本文', 'PASS', '学籍番号・氏名あり');
  }

  // 4 形式
  const wantsPdf = /pdf/i.test(desc) || /\.pdf$/i.test(want || '');
  if (!wantsPdf) add(4, '形式', 'SKIP', '説明文に形式の指定なし');
  else if (/\.pdf$/i.test(base) && isPdf) add(4, '形式', 'PASS', 'PDF の実ファイル');
  else add(4, '形式', 'NG', `PDF を求められているが、${/\.pdf$/i.test(base) ? '中身が PDF でない' : '拡張子が .pdf でない'}`);

  // 5 期限・状態
  let due = null;
  if (work.dueDate) {
    const { year, month, day } = work.dueDate;
    const { hours = 23, minutes = 59 } = work.dueTime || {};
    due = new Date(Date.UTC(year, month - 1, day, hours, minutes));
  }
  const dueStr = due ? due.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' }) : '期限なし';
  if (sub && ['TURNED_IN', 'RETURNED'].includes(sub.state)) add(5, '期限・状態', 'NG', `すでに提出済み（${sub.state}）。出し直すなら Classroom で提出を取り消してから`);
  else if (due && Date.now() > due.getTime()) add(5, '期限・状態', 'NG', `期限切れ（${dueStr}）`);
  else add(5, '期限・状態', 'PASS', `期限 ${dueStr}`);

  // 6 配布資料
  const size = fs.statSync(file).size;
  const hit = Object.entries(new Ledger().data.entries).find(([, e]) =>
    [e.dest, e.movedTo].some((p) => p && path.basename(p).normalize('NFC') === base.normalize('NFC')) && (!e.bytes || e.bytes === size));
  if (hit) add(6, '配布資料', 'NG', `教材の台帳にあるファイル（${hit[0]}）`);
  else add(6, '配布資料', 'PASS', '台帳に無い');

  return { ok: !results.some((r) => r.status === 'NG'), results, work, want };
}

export function printGate({ ok, results, work }) {
  console.log(`▶ 提出ゲート: ${work.title}`);
  for (const r of results) console.log(`  ${r.no} ${r.label.padEnd(6, '　')} ${r.status.padEnd(4)} ${r.detail}`);
  console.log(ok ? '✓ ゲート通過' : '✗ ゲートで止めました（NG を直してからやり直す。どうしても通すなら --force）');
}

// 科目フォルダの 提出ルール.md の「記録」表に1行足す（無ければ何もしない）
export function appendRecord(file, note) {
  const dir = path.dirname(path.resolve(file));
  for (const d of [dir, path.dirname(dir)]) {
    const md = path.join(d, '提出ルール.md');
    if (!fs.existsSync(md)) continue;
    const round = path.basename(dir);
    const rel = path.relative(d, path.resolve(file));
    fs.appendFileSync(md, `| ${round} | \`${rel}\` | ${note} |\n`);
    return md;
  }
  return null;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [url, file] = process.argv.slice(2);
  if (!url || !file) { console.error('使い方: node classroom/gate.mjs "<課題URL>" "<ファイル>"'); process.exit(1); }
  if (!fs.existsSync(file)) { console.error('ファイルが無い:', file); process.exit(1); }
  const res = await runGate(url, file);
  printGate(res);
  process.exit(res.ok ? 0 : 3);
}
