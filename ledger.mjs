// ledger.mjs — DL済み台帳（共通土台）
//   「どこに保存したか」ではなく「安定ID」で取得済みを記録する。
//   これにより、sirius-materials から TUAT 等へファイルを移動しても再DLしない。
//   保存先: ~/.local/share/sirius-fetch/ledger.json （SIRIUS_LEDGER で変更可）
//
//   キー設計（安定ID）:
//     sakai:<siteId>:<相対パス>     Sakaiリソース
//     classroom:drive:<fileId>      Classroom Drive添付（fileIdは不変なので理想）
//     classroom:ext:<URL>           Classroom 外部リンク(Dropbox等)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEDGER_PATH = process.env.SIRIUS_LEDGER ||
  path.join(os.homedir(), '.local/share/sirius-fetch/ledger.json');

export class Ledger {
  constructor() {
    try { this.data = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); }
    catch { this.data = { version: 1, entries: {} }; }
    if (!this.data.entries) this.data.entries = {};
  }
  // 取得済み(=done)または取得不能(=blocked、教員がDL禁止にした動画等)なら true
  has(key) {
    const e = this.data.entries[key];
    return !!(e && (e.status === 'done' || e.status === 'blocked'));
  }
  get(key) { return this.data.entries[key]; }
  record(key, info) {
    this.data.entries[key] = { ...this.data.entries[key], ...info, updatedAt: new Date().toISOString() };
  }
  // #4(自動移行)で移動先を記録する
  setMoved(key, movedTo) {
    if (this.data.entries[key]) this.data.entries[key].movedTo = movedTo;
  }
  save() {
    fs.mkdirSync(path.dirname(LEDGER_PATH), { recursive: true });
    fs.writeFileSync(LEDGER_PATH, JSON.stringify(this.data, null, 2));
  }
}

export const keySakai = (siteId, rel) => `sakai:${siteId}:${rel}`;
export const keyDrive = (fileId) => `classroom:drive:${fileId}`;
export const keyExternal = (url) => `classroom:ext:${url}`;
export const LEDGER_FILE = LEDGER_PATH;
