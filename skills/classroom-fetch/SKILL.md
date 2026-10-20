---
name: classroom-fetch
description: "Google Classroom(大学)の各コースから教材添付(Drive/Driveフォルダ/Dropbox等の外部リンク)を差分ダウンロードする。『Classroomの教材落として』『クラスルームの資料取得』『先生がClassroomに上げた資料』『Dropboxリンクの講義資料』等で使う。Classroom/Drive APIを直接叩く方式(Playwright不要)。実体は ~/Projects/sirius-fetch/classroom/materials.mjs。前提: classroom/auth.mjs で一度だけ認証。"
---

# Google Classroom 教材取得

**Classroom API + Drive API 方式**（2026-08-11にスクレイプから移行）。Sakaiに無い教材がここにある。

Playwrightもセッション(`classroom_state.json`)も**使わない**。`sirius-session` は前提ではない。

## 前提: 初回だけ認証

```bash
# 自分の Google Cloud プロジェクトで作った OAuth クライアント（デスクトップアプリ）の値。本人が入力（伏せ字）
node secret.mjs set classroom-client-id
node secret.mjs set classroom-client-secret

cd ~/Projects/sirius-fetch
node classroom/auth.mjs        # ブラウザで @st.go.tuat.ac.jp を選んで同意
# redirect_uri_mismatch が出たら: node classroom/auth.mjs --port <登録済みポート>
```

トークン: `~/.local/share/sirius-fetch/classroom-token.json`（自動リフレッシュ）。
スコープは取得専用（`*.readonly` + `drive.readonly`）で、提出・添付の権限は持たせていない。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node classroom/materials.mjs                 # 全コースの教材を差分DL
node classroom/materials.mjs --year 2026     # コース名に2026を含むコースのみ
node classroom/materials.mjs --course <id>   # 指定コースのみ(複数可)
```
`--course` は数値ID(`123456789012`)でもURL由来のID(`MTIzNDU2Nzg5MDEy`)でも通る（後者は前者のbase64なので内部で復号）。

出力: `~/Downloads/sirius-materials/classroom/<コース>/`（新規だけ）。manifest: `~/.local/share/sirius-fetch/output/classroom-materials.json`。

## 仕組み・落とし穴（重要）

- 投稿の取得元は **courseWork（課題）／ courseWorkMaterials（資料）／ announcements（お知らせ）の3つ**。お知らせにしか教材が無いコースがあるため（例: 全教材をストリームに流す科目、講義資料をストリームの Dropbox リンクで配る科目がある）、3つとも必ず見る。
- 添付は `materials[]` の union: `driveFile` / `link` / `form` / `youtubeVideo`。**加えて本文（`description` / `text`）のベタ貼りURLも正規表現で拾う**（お知らせに多い）。フォームは対象外（→ `classroom-forms`）。
- Driveの解決は mimeType で分岐する。`…apps.shortcut` は `shortcutDetails.targetId` で実体へ、`…apps.folder` は `files.list(q="'<id>' in parents")` で列挙して再帰（最大4階層）。**旧版のUIスクロール数え上げは不要になった**。
- DL方式: Googleネイティブは `files.export`（document/presentation/drawing→PDF、spreadsheet→xlsx）、それ以外は `files.get(alt=media)`。
- **DL禁止は `capabilities.canDownload === false` で取りに行く前に判定**して ⊘ blocked（台帳にblocked記録、再試行しない）。旧版のHTML本文「ダウンロードできません」検知の置き換え。
- 添付フォルダは中身が提出物のことがあるので `_リンクフォルダ_<フォルダ名>/` に分離。
- 「クラスのドライブ フォルダ」は `materials[]` に現れない（`course.teacherFolder` 扱い）ので、旧版のaria-label除外は不要になった。
- Dropbox: `dl=0→dl=1`＋content-dispositionで正式名。timeout 180s。

## 未参加コース（クラスコードの探し方）

APIのトークンは読み取り専用なので、**参加は本人の操作**（classroom.google.com の「＋」→「クラスに参加」でコード入力）。参加リンク `https://classroom.google.com/c?cjc=<コード>` は404になるので使わない。参加するまで `materials.mjs` にそのコースは出てこない。

コードは次の順に探す（2026-10-05 時点の実績）:
1. **Sakai のお知らせ**：`/direct/announcement/site/<siteId>.json`。`<siteId>` は `2026_02_<時間割コード>`
2. **SIRIUS シラバスの「概要」欄**：flow `SBW3701300-flow` で `#jikanwaricdFrom/#jikanwaricdTo` に時間割コード → `#jikanwariSearchForm-auto-input-12` → `input[name=refer][value="和文"]`。**詳細はポップアップで開く**ので `context.waitForEvent('page')` で受け、`script` を除いた `textContent` から `クラスコード` を探す（`【Google Classroom クラスコード】` として概要の先頭に書かれていた例がある）
3. 大学メール（`クラスコード OR 科目名 OR 教員名`）・SIRIUS 掲示：どちらも実績なし

参加後は `node classroom/materials.mjs --year 2026` で取得し、**`private/migrate-config.mjs` の `buildJobs` にそのコースを足す**（足さないと振り分け対象外になる。`tuat-organize` 参照）。

## 台帳による差分

- キー: Drive=`classroom:drive:<fileId>`(不変で理想)、外部=`classroom:ext:<URL>`。`has()`がdone/blockedでtrue。**スクレイプ版と同じキーなので、移行で再DLは起きない**。
- フォルダは**遅延作成**（新規DL時のみ）。新規が無ければ直下を汚さない。

## 終了コード

| code | 意味 | 対処 |
|---|---|---|
| 1 | 資格情報（Keychain/資格情報マネージャー）未設定 / 未認証 | 上の「前提」を実行 |
| 2 | 認証切れ(invalid_grant) | `node classroom/auth.mjs` で再同意。**`classroom/login.mjs` では直らない** |

取得後の振り分けは `tuat-organize`（コース名→科目フォルダ、Lecture番号→講義回など）。
