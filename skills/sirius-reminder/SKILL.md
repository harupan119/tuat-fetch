---
name: sirius-reminder
description: "Sakai/Classroomの未提出課題をObsidianデイリーノートの『## 📚 課題』セクションと Google カレンダーに反映する（締切リマインドの連携）。『課題をデイリーノートに出して』『今日のノートに締切まとめて』『未提出をノートに同期』『課題をカレンダーに入れて』『締切をカレンダー同期』等で使う。実体は ~/Projects/sirius-fetch/{reminder-daily,sync-calendar}.mjs。"
---

# 課題リマインド → デイリーノート連携

Sakai/Classroom の未提出課題を、Obsidian デイリーノート `<SIRIUS_DIARY_DIR>/YYYY-MM-DD.md` の **`## 📚 課題`** セクションに冪等反映する（セクション単位の冪等更新。他の見出しには触らない）。

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
- **デイリーノートが無ければ何もしない**（ノートを作る側の処理から呼ぶか、fetch-all の定期実行で反映する）。
- 未提出は毎回上書き（提出済みは次回 fetch で `未提出` から消えるので自然に落ちる）。

## 呼び出し元

- デイリーノートを作る処理（テンプレートやスクリプト）の最後に `node reminder-daily.mjs` を呼ぶと、作成直後から `## 📚 課題` が埋まる。
- **fetch-all（launchd / タスクスケジューラ）**: 定期取得の最後に `reminder-daily.mjs` を実行（当日ノートがあれば自動更新）。
- `## 📚 課題` 以外のセクションは書き換えないので、他のツールが同じノートを更新しても干渉しない。

デイリーノートの場所は環境変数 `SIRIUS_DIARY_DIR`（既定 `~/Documents/Obsidian/Diary`）。課題扱いしない見出しは `SIRIUS_IGNORE_KEYWORDS`（カンマ区切り。sync-calendar と共通）。

## Google カレンダー同期（sync-calendar.mjs）

未提出課題を Google カレンダーに締切の終日予定として登録する。同期先は環境変数 `SIRIUS_GCAL_ID`（カレンダーの設定 →「カレンダーの統合」の ID。未指定ならメインのカレンダー）。台帳 `~/.local/share/sirius-fetch/calendar-synced.json` で二重登録を防ぐ。

```bash
node sync-calendar.mjs              # 未同期の課題を一覧表示（登録しない）
node sync-calendar.mjs --sync       # Google Calendar API で登録（fetch-all が毎回実行）
node sync-calendar.mjs --json       # 未同期の課題を JSON で出す
node sync-calendar.mjs --mark KEY   # 同期済みとして台帳に記録
```
- 初回だけ: 本人が `node secret.mjs set gcal-client-id` と `gcal-client-secret` を登録し、`node google-auth.mjs` で同意する。同意は同期先カレンダーを所有するアカウントで行う（Chrome のプロファイルは `CHROME_PROFILE` で指定。既定 `Default`）。
- `invalid_grant` で落ちたら認証切れ。残りは試さず exit 1 になるので、`node google-auth.mjs` で取り直す。
