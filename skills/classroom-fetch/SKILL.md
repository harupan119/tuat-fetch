---
name: classroom-fetch
description: "Google Classroom(大学)の各コースから教材添付(Drive/Driveフォルダ/Dropbox等の外部リンク)を差分ダウンロードする。『Classroomの教材落として』『クラスルームの資料取得』『先生がClassroomに上げた資料』『Dropboxリンクの講義資料』等で使う。Classroom APIは使えずスクレイプ方式。実体は ~/Projects/sirius-fetch/classroom/materials.mjs。前提: sirius-session。"
---

# Google Classroom 教材取得

**Classroom APIは不可**（大学Workspaceが学生にGoogle Cloudプロジェクト作成を許可しない）→ **スクレイプ方式**。Sakaiに無い教材がここにある。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node classroom/materials.mjs                 # 全コースの教材を差分DL
node classroom/materials.mjs --year 2026     # タイトルに2026を含むコースのみ
node classroom/materials.mjs --course <id>   # 指定コースのみ(複数可)
```
出力: `~/Downloads/sirius-materials/classroom/<コース>/`（新規だけ）。manifest: `~/.local/share/sirius-fetch/output/classroom-materials.json`。

## 仕組み・落とし穴（重要）

- コース一覧(`/u/0/h`)→各コースの**授業タブ(`/w/{id}/t/all`)＋ストリームタブ(`/c/{id}`)の両方**を走査（教材は授業タブだけでなくお知らせ本文にもある。例: 全教材がストリーム投稿だけの科目、講義資料がストリーム本文の外部リンク(Dropbox等)になっている科目がある）。
- **投稿展開は in-page JS で `[role="button"][aria-expanded="false"]` を全click**（Playwrightロケータでは掴めない要素 → `page.evaluate()` 内で `b.click()` が必須）。
- 収集対象: ①Drive添付`a[aria-label^="添付ファイル"]`の`/file|document|presentation|spreadsheets/d/{id}` ②Driveフォルダ添付(中身が提出物の場合あり→`_リンクフォルダ/`に分離、ショートカットは`/file/d/{id}/view`で実体IDへ解決) ③お知らせ本文の外部リンク(Dropbox等)。
- DL方式: Drive binary=`uc?export=download&confirm=t`→大容量はウイルススキャン確認の新form(`<input>`解析)を解いて`drive.usercontent.google.com/download`再取得。Googleネイティブは`/export`(PDF/xlsx)。**DL禁止動画は「ファイルをダウンロードできません」検知で ⊘ blocked**（台帳にblocked記録、再試行しない）。
- Dropbox: `dl=0→dl=1`＋content-dispositionで正式名。「クラスのドライブ フォルダ」(学生自身の空フォルダ)はaria-labelで除外。timeout 180s。

## 台帳による差分

- キー: Drive=`classroom:drive:<fileId>`(不変で理想)、外部=`classroom:ext:<URL>`。`has()`がdone/blockedでtrue。
- フォルダは**遅延作成**（新規DL時のみ）。新規が無ければ直下を汚さない。

取得後の振り分けは `tuat-organize`（コース名→科目フォルダ、Lecture番号→講義回など）。
