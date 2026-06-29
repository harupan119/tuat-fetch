---
name: sirius-portal
description: "TUAT/SIRIUSポータルの時間割・休講補講・お知らせ(掲示)と、未提出課題のリマインドを取得する。『休講ある?』『お知らせ確認』『時間割取って』『未提出の課題/締切を出して』『大学の締切リマインド』等で使う。実体は ~/Projects/sirius-fetch/。前提: sirius-session。"
---

# SIRIUS ポータル取得（時間割・休講・お知らせ・課題リマインド）

ファイルDLではなく**学務情報とリマインド**の取得担当。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node fetch.mjs                 # 時間割＋休講補講＋お知らせを一括取得 → output/
node assignments.mjs          # Sakaiの未提出課題を締切順に → output/assignments-todo.md ＋ macOS通知
node classroom/fetch.mjs      # Classroomの未提出課題 → output/classroom-todo.md ＋ macOS通知
```
出力先: `~/.local/share/sirius-fetch/output/`

## 仕組み・落とし穴

- 主要flowId: 掲示板`KJW0001100` / 履修時間割`RSW0001000` / 休講補講`KHW0001100` / 成績`SIW0001300` / シラバス`SBW3701300` / ダウンロードセンター`SDW0001000`。
- 掲示は Spring WebFlow(`_eventId`)で `_flowExecutionKey` が毎回変わる → **URL直打ち不可、DOMクリックで辿る**。
- 時間割はグリッド表(限ラベル＋月〜土6セル×6限)をパース。
- **Sakai未提出判定**: REST(`/direct/assignment/...`)は開閉`status`(OPEN/CLOSED)のみで自分の提出状態を返さない → Assignmentsツール画面(toolId `sakai.assignment.grades`、`/direct/site/{id}/pages.json`でURL取得)の「状態」列をスクレイプ:「提出日時 …」=提出済/「開始されていません」=未提出。
- **Classroom未提出**: not-turned-inページ(`/u/0/a/not-turned-in/all`)をスクレイプ。課題リンク`a[href*="/a/"][href*="/details"]`からtitle/course/due抽出、「投稿:」を含む古い資料は除外。

## デイリーノート連携（実装済）

`output/assignments-todo.md` / `classroom-todo.md` を Obsidian デイリーノート `01_Diary/YYYY-MM-DD.md` の **`## 📚 課題`** セクションへ反映する `reminder-daily.mjs` がある（`node reminder-daily.mjs`）。morning / task-sync / fetch-all.sh から共有実行。詳細は **`sirius-reminder`** スキル。
