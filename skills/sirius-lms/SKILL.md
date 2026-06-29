---
name: sirius-lms
description: "Sakai(SIRIUS統合LMS, lms.sirius.tuat.ac.jp)から教材ファイルと課題定義を差分取得する。『Sakaiの教材落として』『LMSの資料/レジュメ取得』『講義資料を全部ダウンロード』等で使う。台帳による差分DL・著作権制限の自動突破つき。実体は ~/Projects/sirius-fetch/materials.mjs。前提: sirius-session。"
---

# Sakai(LMS) 教材・課題取得

Sakai REST `/direct/` を SIRIUS の SSO セッションで叩き、教材を**差分ダウンロード**する。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node materials.mjs                  # 全履修サイトの教材＋課題を差分DL
SIRIUS_TERM=2026_02 node materials.mjs   # 学期(サイトidプレフィックス)で絞る
SIRIUS_MAT_DIR=/path node materials.mjs  # 出力先変更(既定 ~/Downloads/sirius-materials)
```
出力: `~/Downloads/sirius-materials/<科目>/...`（新規だけ。`_課題.md`は新規があった科目のみ）。インデックス `INDEX.md`。

## 仕組み・落とし穴（重要）

- REST: `membership.json`(履修サイト)／`content/site/{id}.json`(教材)／`assignment/site/{id}.json`(課題)。
- **必ず `?_limit=999`(教材は9999)を付ける**。デフォルト件数上限で現学期サイトが隠れる（これを忘れて「2026前期がSakaiに無い」と誤判定した実績あり）。
- **サイトidは `YYYY_FF_コード`。真ん中FFは学部コード(工学部=02)で学期ではない** → 年度はidから確実、前期/後期はidから判別不可（`tuat-organize`が既存TUATフォルダ等で判定）。
- **著作権制限教材**: `context.request.get`が「著作権制限付きダウンロード警告」HTMLを返す → 本文の `/access/accept?ref=…&url=…` リンクを叩いて実ファイル取得（自動突破実装済）。
- HTML応答(`<!DOCTYPE`)が返ったら取得失敗としてスキップ。

## 台帳による差分（再DL防止）

- `ledger.mjs` の `Ledger` を使用。キー `sakai:<siteId>:<相対パス>`。
- スキップ判定 = `ledger.has(key) || 現在地にサイズ一致で存在`（後者は初回バックフィル）。
- **TUATへ移動しても再DLされない**のはこの台帳のおかげ（保存場所でなく安定IDで記録）。`~/.local/share/sirius-fetch/ledger.json`。
- フォルダは**遅延作成**（新規DL時のみ）。新規が無ければ直下を汚さない。

取得後の振り分けは `tuat-organize`。
