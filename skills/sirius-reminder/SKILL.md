---
name: sirius-reminder
description: "Sakai/Classroomの未提出課題をObsidianデイリーノートの『## 📚 課題』セクションに反映する（締切リマインドのデイリーノート連携）。『課題をデイリーノートに出して』『今日のノートに締切まとめて』『未提出をノートに同期』等で使う。morning/task-sync と同じデイリーノートを共有。実体は ~/Projects/sirius-fetch/reminder-daily.mjs。"
---

# 課題リマインド → デイリーノート連携

Sakai/Classroom の未提出課題を、Obsidian デイリーノート `01_Diary/YYYY-MM-DD.md` の **`## 📚 課題`** セクションに冪等反映する。morning / task-sync と同じノート・同じ流儀（セクション単位の冪等更新）。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node assignments.mjs && node classroom/fetch.mjs   # 未提出を最新化（任意。古ければ実行）
node reminder-daily.mjs            # 今日のデイリーノートに反映
node reminder-daily.mjs 2026-06-25 # 日付指定も可
```

## 動作

- 元データ: `~/.local/share/sirius-fetch/output/{assignments-todo.md, classroom-todo.md}`（`sirius-portal` が生成）。
- `## 📚 課題` セクションを **挿入 or 全置換**（冪等）。配置は `## ⏳ タスク` の直後。
- 行形式: `- [ ] **課題名**（科目）〆締切 …  ｜Sakai`／`… ｜Classroom [開く](URL)`。
- **デイリーノートが無ければ何もしない**（morning がノート作成時に本スクリプトを呼ぶ）。
- 未提出は毎回上書き（提出済みは次回 fetch で `未提出` から消えるので自然に落ちる）。

## morning系との共有・棲み分け

- **morning**: デイリーノート作成/更新の最後に `reminder-daily.mjs` を実行 → 作成直後から `## 📚 課題` が埋まる。
- **task-sync**: Firstseed同期に加え `reminder-daily.mjs` を実行して `## 📚 課題` も最新化（task-sync が触るのは `## ⏳ タスク`/`## 📬 重要メール`、課題は本スキルが `## 📚 課題` を担当するので競合しない）。
- **fetch-all.sh / launchd**: 定期取得の最後に `reminder-daily.mjs` を実行（当日ノートがあれば自動更新）。
- セクション分離により Firstseedタスク(📅マーカー, `## ⏳ タスク`)と課題(`## 📚 課題`)は互いに干渉しない。

注意: `.md` を手で編集する場合は obsidian 系スキル(obsidian-markdown)に従う。本連携はスクリプトがセクション単位で安全に書き換える。
