---
name: sirius-lms
description: "Sakai(SIRIUS統合LMS, lms.sirius.tuat.ac.jp)から教材ファイルと課題定義を差分取得する。授業(Lessons)ページに貼られた OneDrive 資料（パスワード付きPDFの解除つき）も取る。『Sakaiの教材落として』『LMSの資料/レジュメ取得』『講義資料を全部ダウンロード』『OneDriveの資料』『授業ページの資料』等で使う。台帳による差分DL・著作権制限の自動突破つき。実体は ~/Projects/sirius-fetch/{materials,onedrive}.mjs。前提: sirius-session。"
---

# Sakai(LMS) 教材・課題取得

Sakai REST `/direct/` を SIRIUS の SSO セッションで叩き、教材を**差分ダウンロード**する。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node materials.mjs                  # 全履修サイトの教材＋課題を差分DL
SIRIUS_TERM=2026_02 node materials.mjs   # 学期(サイトidプレフィックス)で絞る
SIRIUS_MAT_DIR=/path node materials.mjs  # 出力先変更(既定 ~/Downloads/sirius-materials)
node onedrive.mjs                   # 授業(Lessons)ページ内の OneDrive 資料を差分DL（下記）
```
PowerShell では環境変数を `$env:SIRIUS_TERM='2026_02'; node materials.mjs` の形で渡す（Git Bash ならそのまま）。
出力: `~/Downloads/sirius-materials/<科目>/...`（新規だけ。`_課題.md`は新規があった科目のみ）。インデックス `INDEX.md`。

## 仕組み・落とし穴（重要）

- REST: `membership.json`(履修サイト)／`content/site/{id}.json`(教材)／`assignment/site/{id}.json`(課題)。
- **必ず `?_limit=999`(教材は9999)を付ける**。デフォルト件数上限で現学期サイトが隠れる（これを忘れて「2026前期がSakaiに無い」と誤判定した実績あり）。
- **サイトidは `YYYY_FF_コード`。真ん中FFは学部コード(工学部=02)で学期ではない** → 年度はidから確実、前期/後期はidから判別不可（`tuat-organize`が既存TUATフォルダ等で判定）。
- **著作権制限教材**: `context.request.get`が「著作権制限付きダウンロード警告」HTMLを返す → 本文の `/access/accept?ref=…&url=…` リンクを叩いて実ファイル取得（自動突破実装済）。
- HTML応答(`<!DOCTYPE`)が返ったら取得失敗としてスキップ。

## 「授業」（レッスン）ページの教材は materials.mjs で取れない

ある科目で、スライドが `materials.mjs` で取れなかった（「ファイル1 / 新規DL 0」）。教員によっては、スライドを「授業資料」（リソース）ではなく**「授業」ページ（Lessons、`sakai.lessonbuildertool`）の各回の中**に置く。`content/site/{id}.json` はリソースしか返さないので、ここに置かれたファイルは一覧に出ない。**「Sakaiに資料が無い」と判断する前に、必ずレッスンも見る**。

- 構造：`/direct/lessons/site/{siteId}.json` → `lessons_collection[].id`（トップ）→ `/direct/lessons/lesson/{id}.json` の `contentsList`。各回のサブページは `type:2`、その **`id`（`sakaiId` ではない）** を同じ API に渡すと中のファイル（`type:1`、`url` が `/access/content/group/<site>/授業/第N回_ClassN/…`）が出る。
- サイトのツール一覧は `/direct/site/{siteId}/pages.json`（`toolId` と placement id）。
- **`prerequisite:true` の項目は、そのまま GET すると 403**（`/access/content/…` も `/access/lessonbuilder/item/<itemId>/…` も）。ブラウザと同じく、**レッスンのページを一度開いてから** `a.itemlink` の href（`/access/lessonbuilder/item/<itemId>/group/…`）を GET すると 200 で取れた。手順：`page.goto(${LMS}/portal/site/<site>/tool/<lessonbuilderのplacement>)` → `getByText('第N回/ClassN').click()` → リンクの href を `context.request.get`。
- Sakai の課題・小テスト・お知らせの確認は同じセッションで `/direct/assignment/site/{id}.json`・`/direct/sam_pub/context/{id}.json`・`/direct/announcement/site/{id}.json`。小テストの一覧は API で空でも、ツール画面（`samigo`）の本文で「受験可能なテストは現在ありません」を確かめられる。
- `materials.mjs` はまだレッスン内のファイルに対応していない。OneDrive へのリンクだけは下の `onedrive.mjs` が取る。

## 授業ページの OneDrive 資料（onedrive.mjs）

教材を Sakai リソースに置かず、Lessons ページ本文から OneDrive/SharePoint（`metuat-my.sharepoint.com`）へリンクする科目がある。

- 流れ: Sakai REST で Lessons 本文を読む → SharePoint リンクを抽出 → Microsoft(@st.me.tuat.ac.jp)に大学SSO経由でログイン → 共有リンク＋`download=1` で取得。
- 出力: `~/Downloads/sirius-materials/<科目>/第N回/<ファイル>`（N は本文中の直前の「#NN」見出し）。`第N回` を含めるのは `migrate.mjs` の `mode:'path'` で講義回へ振り分けるため。
- **パスワード付きPDF**: 資格情報ストアの `sirius-pdfpass-<siteId>` で解除して保存（本人が `node secret.mjs set sirius-pdfpass-<siteId>` で登録）。解除は Python の `pypdf`＋`cryptography` を使う。Python は macOS では Homebrew の `python3`、Windows では `python`。`SIRIUS_PYTHON` で上書き可。
- 台帳キー: `onedrive:<共有リンクの origin+pathname>`（`?e=` 等のクエリは毎回変わるので除く）。学期: 既定は今年度のサイトのみ（`SIRIUS_TERM` で上書き）。

## 台帳による差分（再DL防止）

- `ledger.mjs` の `Ledger` を使用。キー `sakai:<siteId>:<相対パス>`。
- スキップ判定 = `ledger.has(key) || 現在地にサイズ一致で存在`（後者は初回バックフィル）。
- **TUATへ移動しても再DLされない**のはこの台帳のおかげ（保存場所でなく安定IDで記録）。`~/.local/share/sirius-fetch/ledger.json`。
- フォルダは**遅延作成**（新規DL時のみ）。新規が無ければ直下を汚さない。

取得後の振り分けは `tuat-organize`。
