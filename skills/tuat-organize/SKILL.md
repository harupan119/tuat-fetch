---
name: tuat-organize
description: "取得した大学教材(Downloads/sirius-materials)を TUAT 正本フォルダへ年度・前期/後期・科目・講義回で再配置し、過去分を学期アーカイブへ退避する。『TUATに振り分けて』『教材を整理/再配置』『ダウンロードした資料をしまって』『重複を避けて移動』等で使う。実体は ~/Projects/sirius-fetch/migrate.mjs。"
---

# TUAT 整理・再配置（migrate）

取得物を**正本=TUAT**へ移し、過去分を**学期アーカイブ**へ退避して直下を空ける。設計方針「TUATを正本に一本化」。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node migrate.mjs            # dry-run（計画だけ表示。必ず先に確認）
node migrate.mjs --apply    # 実行
node migrate.mjs --ay <年度> # 年度で絞る
```
- 移動先(正本): `~/Documents/TUAT/TUAT_<学年>_<前期|後期>/<科目>/<講義回>/`
- 退避(生アーカイブ): `~/Downloads/sirius-materials/_アーカイブ/<年度><前期|後期>/<コース>/`
- 移動ログ(復元用): `~/.local/share/sirius-fetch/migrate-log-*.json`

## 動作（重要）

- **重複判定はmd5(内容一致)**。TUATのどこかに同一内容があれば「既存」→正本へは入れず学期アーカイブへ退避。新規だけ正本へ移動。
- **除外メタ**(_課題.md/.URL/INDEX.md/_提出物_誤取得)も学期アーカイブへ送り、直下を空ける。
- **年度はサイトidから確実、前期/後期は判別不可**(idのFFは学部コード)→既存TUATフォルダ名/日程で判定。入学年度→TUAT_1、その次の年度→TUAT_2（`buildJobs` の `sem` で指定）。学期=`ay`+sem(後期含むなら後期)。
- 名前衝突は ` (sirius)` を付与。空ディレクトリは掃除。

## 講義回(サブフォルダ)判定 mode（科目別指定は private/migrate-config.mjs）

- `path`: パスの`第N回` → NN（Sakai標準）
- `ipr`: ファイル名の`第N回`（レポートは`_etc`）
- `num`: 先頭数字（例「09.pdf」）
- その他: 科目固有の命名規則に合わせた抽出を private 側の `classify` に足す（不明は`_要確認`、対象外は`_etc`）
- `flat`: 回が曖昧（日付名等）→ `_sirius/` に隔離して誤配置を防ぐ

科目固有の `mode` と配置ジョブは個人の履修内容に依存するため、`private/migrate-config.mjs`（gitignore対象）の `buildJobs` / `classify` に定義する。公開リポには架空サンプル `migrate-config.example.mjs` が同梱。新科目を足すときは private 側の `buildJobs` に `{ay, src, sem, subj, mode, note}` を追加する。**新しく参加した Classroom のコースは、取得しても `buildJobs` に無いと移動されない**。登録の無いフォルダに教材がある時は、実行の最後に `⚠ JOBS未登録で振り分け対象外のフォルダ` として一覧が出るので、そこに科目が出たら足す。科目外(サークル等)は対象外（個別フォルダへ手動）。

## 運用フロー

`sirius-portal`/`sirius-lms`/`classroom-fetch` で取得（新規が直下に出る）→ `node migrate.mjs` で計画確認 → `--apply` で正本＋アーカイブへ。台帳(`ledger.json`)が移動後の再DLを防ぐので安心して移動してよい。定期実行の `fetch-all` は `--apply` まで行う。

Windows でも同じ（パスの区切りは Node の `path` が吸収する。判定はファイル名とパス中の `第N回` だけを見るので区切り文字に依存しない）。
