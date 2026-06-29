// migrate-config.example.mjs — 配置ルールのサンプル（公開用・架空データ）
//   自分用は private/migrate-config.mjs にコピーして履修科目に合わせて編集する（gitignore対象）。
//   migrate.mjs から { buildJobs, classify } として読み込まれる。

// buildJobs({DL, CR}) は配置ジョブ配列を返す。
//   DL = 取得の一時置き場(~/Downloads/sirius-materials), CR = DL/classroom
//   src=元フォルダ, sem=TUAT配下の学期フォルダ, subj=科目フォルダ名, mode=回判定方式, ay=年度, note=補足
export function buildJobs({ DL, CR }) {
  return [
    // 例: Sakai取得の科目フォルダ（曜限つきの名前で落ちてくる想定）
    { ay: '2099', src: `${DL}/['99月1]サンプル科目A`, sem: 'TUAT_X_前期', subj: 'サンプル科目A', mode: 'path' },
    { ay: '2099', src: `${DL}/['99火2]Sample Lecture B`, sem: 'TUAT_X_前期', subj: 'Sample Lecture B', mode: 'num' },
    // 例: Classroom取得の科目フォルダ
    { ay: '2099', src: `${CR}/2099 サンプル科目C`, sem: 'TUAT_X_前期', subj: 'サンプル科目C', mode: 'flat', note: '回が曖昧なら_sirius/へ隔離' },
  ];
}

const zero = (n) => String(n).padStart(2, '0');

// 回(サブフォルダ)を決定する。mode ごとにファイル名から「第N回」を抽出するルール。
//   汎用modeのみ掲載。科目固有の命名規則がある場合は private 側で case を足す。
export function classify(mode, rel, base) {
  const pNum = rel.match(/第\s*(\d+)\s*回/);
  if (rel.startsWith('_課題添付')) return pNum ? zero(pNum[1]) : '_課題';
  if (/中間レポート/.test(rel)) return 'mid/中間レポート';
  switch (mode) {
    case 'path': return pNum ? zero(pNum[1]) : '_sirius';                       // 名前の「第N回」で判定
    case 'num': { const m = base.match(/^(\d+)/); return m ? zero(m[1]) : '_sirius'; } // 先頭の数字
    case 'flat': return '_sirius';                                             // 回が曖昧 → 隔離
    default: return pNum ? zero(pNum[1]) : '_sirius';
  }
}
