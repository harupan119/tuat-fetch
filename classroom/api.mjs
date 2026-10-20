// classroom/api.mjs — Google Classroom / Drive REST API の共通土台
//   Playwrightスクレイプの置き換え。認証・ページング・素材の正規化をここに集約する。
//
//   前提: 一度だけ `node classroom/auth.mjs` で同意フロー（トークンは下記に保存）
//   トークン: ~/.local/share/sirius-fetch/classroom-token.json
//   クライアント: Keychain / 資格情報マネージャーの classroom-client-id / classroom-client-secret
//
//   終了コード規約（既存スクリプトと揃える）:
//     1 = 未設定（Keychain/トークンが無い）  2 = 認証切れ（再同意が必要）
import { google } from 'googleapis';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { keychain } from '../lib.mjs';
import { secretHint, secretStoreName } from '../platform.mjs';

const DATA = path.join(os.homedir(), '.local/share/sirius-fetch');
export const TOKEN_PATH = path.join(DATA, 'classroom-token.json');

// 取得専用。提出・添付は行わないので readonly のみを要求する。
export const SCOPES = [
  'https://www.googleapis.com/auth/classroom.courses.readonly',
  'https://www.googleapis.com/auth/classroom.coursework.me.readonly',
  'https://www.googleapis.com/auth/classroom.courseworkmaterials.readonly',
  'https://www.googleapis.com/auth/classroom.announcements.readonly',
  'https://www.googleapis.com/auth/drive.readonly',
];

export function oauthClient(redirectUri) {
  const clientId = keychain('classroom-client-id');
  const clientSecret = keychain('classroom-client-secret');
  if (!clientId || !clientSecret) {
    console.error(`✗ ${secretStoreName} に classroom-client-id / classroom-client-secret がありません。`);
    console.error(secretHint('classroom-client-id', 'classroom-client-secret'));
    process.exit(1);
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

// 保存済みトークンで認証済みクライアントを返す。リフレッシュ時は自動で保存し直す。
export function authorized() {
  if (!fs.existsSync(TOKEN_PATH)) {
    console.error('✗ 未認証。先に `node classroom/auth.mjs` を実行してください。');
    process.exit(1);
  }
  const auth = oauthClient('http://localhost');
  const tokens = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));
  auth.setCredentials(tokens);
  auth.on('tokens', (t) => {
    const merged = { ...tokens, ...t };
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  return auth;
}

// 認証切れ(invalid_grant)は exit 2。それ以外はそのまま投げる。
export function bailOnAuthError(e) {
  const msg = String(e?.message || e);
  if (/invalid_grant|invalid_rapt|Token has been expired or revoked/i.test(msg)) {
    console.error('✗ 認証切れ。`node classroom/auth.mjs` で再同意してください。');
    process.exit(2);
  }
  throw e;
}

// --- ページングを畳んで全件返す ---
async function pageAll(call, collectionKey, params) {
  const out = [];
  let pageToken;
  do {
    const res = await call({ ...params, pageSize: 100, pageToken });
    out.push(...(res.data[collectionKey] || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return out;
}

// 参加していないコース等で 403/404 が返る場合は空扱いにする（1コースの失敗で全体を止めない）
async function softPageAll(call, collectionKey, params, label) {
  try { return await pageAll(call, collectionKey, params); }
  catch (e) {
    const code = e?.code || e?.response?.status;
    if (code === 403 || code === 404) return [];
    if (/invalid_grant|Token has been expired or revoked/i.test(String(e?.message))) bailOnAuthError(e);
    console.error(`    ! ${label}: ${String(e?.message).slice(0, 120)}`);
    return [];
  }
}

export function classroomApi(auth) { return google.classroom({ version: 'v1', auth }); }
export function driveApi(auth) { return google.drive({ version: 'v3', auth }); }

// asStudent=true で「自分が受講している」コースだけに絞る（教員として入っているコースを除く）
export async function listCourses(auth, { states = ['ACTIVE'], asStudent = false } = {}) {
  const c = classroomApi(auth);
  const params = { courseStates: states };
  if (asStudent) params.studentId = 'me';
  try {
    return await pageAll((p) => c.courses.list(p), 'courses', params);
  } catch (e) { return bailOnAuthError(e); }
}

// 同時実行数を絞って走らせる（Classroom API のレート制限対策）
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n], n); }
  }));
  return out;
}

export const listCourseWork = (auth, courseId) =>
  softPageAll((p) => classroomApi(auth).courses.courseWork.list(p), 'courseWork', { courseId }, `courseWork ${courseId}`);

export const listCourseWorkMaterials = (auth, courseId) =>
  softPageAll((p) => classroomApi(auth).courses.courseWorkMaterials.list(p), 'courseWorkMaterial', { courseId }, `courseWorkMaterials ${courseId}`);

export const listAnnouncements = (auth, courseId) =>
  softPageAll((p) => classroomApi(auth).courses.announcements.list(p), 'announcements', { courseId }, `announcements ${courseId}`);

// 自分の提出状況。courseWorkId='-' で当該コースの全課題ぶんをまとめて取る。
export const listMySubmissions = (auth, courseId) =>
  softPageAll((p) => classroomApi(auth).courses.courseWork.studentSubmissions.list(p),
    'studentSubmissions', { courseId, courseWorkId: '-', userId: 'me' }, `submissions ${courseId}`);

// --- 素材の正規化 ---------------------------------------------------------
// Classroom の Material は driveFile / link / form / youtubeVideo の union。
// 本文(description / text)にベタ貼りされた URL も拾う（お知らせに多い）。
const EXTERNAL_RE = /dropbox\.com|onedrive|1drv\.ms|box\.com|sharepoint|\.(pdf|docx?|pptx?|xlsx?|zip)(\?|$)/i;
const SKIP_HOST_RE = /google\.com|gstatic|youtube|youtu\.be/i;

export function normalizeMaterials(post) {
  const driveFiles = [];
  const forms = [];
  const links = [];
  for (const m of post.materials || []) {
    if (m.driveFile?.driveFile) {
      const d = m.driveFile.driveFile;
      driveFiles.push({ id: d.id, title: d.title || d.id, link: d.alternateLink });
    } else if (m.form?.formUrl) {
      forms.push({ url: m.form.formUrl, title: m.form.title || '' });
    } else if (m.link?.url) {
      const url = m.link.url;
      if (/forms\.google|forms\.gle|docs\.google\.com\/forms/.test(url)) forms.push({ url, title: m.link.title || '' });
      else if (!SKIP_HOST_RE.test(url) && EXTERNAL_RE.test(url)) links.push({ url, title: m.link.title || '' });
    }
  }
  // 本文中のURL
  const body = `${post.description || ''}\n${post.text || ''}`;
  for (const mm of body.matchAll(/https?:\/\/[^\s「」（）()<>"']+/g)) {
    const u = mm[0].replace(/[.,、。]+$/, '');
    if (/forms\.google|forms\.gle|docs\.google\.com\/forms/.test(u)) { forms.push({ url: u, title: '' }); continue; }
    if (!SKIP_HOST_RE.test(u) && EXTERNAL_RE.test(u)) links.push({ url: u, title: '' });
  }
  return { driveFiles, forms, links };
}

// コースの全投稿（課題 / 資料 / お知らせ）を1本の配列で返す
export async function listAllPosts(auth, courseId) {
  const [work, mats, anns] = await Promise.all([
    listCourseWork(auth, courseId),
    listCourseWorkMaterials(auth, courseId),
    listAnnouncements(auth, courseId),
  ]);
  return [
    ...work.map((p) => ({ ...p, kind: 'courseWork' })),
    ...mats.map((p) => ({ ...p, kind: 'material' })),
    ...anns.map((p) => ({ ...p, kind: 'announcement', title: p.title || (p.text || '').split('\n')[0].slice(0, 60) })),
  ];
}

// --- 表示・整形の共通ヘルパ ------------------------------------------------
export const sanitize = (s) =>
  (s || 'untitled').replace(/[\/\\:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 150);

// コース表示名（section があれば併記する既存の見え方に寄せる）
export const courseLabel = (c) => c.name || c.id;

// Classroom の dueDate/dueTime は UTC。JST に直して分解した形で返す。
//   時刻付きは日付が繰り上がることがある（例: 7/10 23:59 UTC → 7/11 08:59 JST）ため、
//   dueDate をそのまま表示に使わず、必ずこの戻り値の y/m/d を使うこと。
const pad = (n) => String(n).padStart(2, '0');
export function dueToJst(dueDate, dueTime) {
  if (!dueDate) return null;
  const { year, month, day } = dueDate;
  if (!dueTime || dueTime.hours === undefined) {
    return { timed: false, y: year, m: month, d: day, iso: `${year}-${pad(month)}-${pad(day)}` };
  }
  const jst = new Date(Date.UTC(year, month - 1, day, dueTime.hours || 0, dueTime.minutes || 0) + 9 * 3600_000);
  const y = jst.getUTCFullYear(), m = jst.getUTCMonth() + 1, d = jst.getUTCDate();
  const hh = jst.getUTCHours(), mm = jst.getUTCMinutes();
  return { timed: true, y, m, d, hh, mm, iso: `${y}-${pad(m)}-${pad(d)} ${pad(hh)}:${pad(mm)}` };
}
export { pad };
