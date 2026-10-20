---
name: sirius-reminder
description: "Sakai/Classroomの未提出課題を、日付ごとのリマインドファイル（.md か .txt）と Google カレンダーに反映する（締切リマインドの連携）。『課題のリマインドを作って』『今日の締切まとめて』『未提出を書き出して』『課題をカレンダーに入れて』『締切をカレンダー同期』等で使う。実体は ~/Projects/sirius-fetch/{reminder-daily,sync-calendar}.mjs。"
---

# 課題リマインド（ファイル書き出し・カレンダー同期）

Sakai/Classroom の未提出課題を、日付ごとのファイル `<SIRIUS_REMINDER_DIR>/YYYY-MM-DD.md`（または `.txt`）に書き出す。特定のノートアプリは前提にしない。

## コマンド

```bash
cd ~/Projects/sirius-fetch
node assignments.mjs && node classroom/fetch.mjs   # 未提出を最新化（任意。古ければ実行）
node reminder-daily.mjs                            # 今日の分を書き出す
node reminder-daily.mjs 2026-06-25                 # 日付指定も可
SIRIUS_REMINDER_FORMAT=txt node reminder-daily.mjs # .txt で書き出す（PowerShell は $env:SIRIUS_REMINDER_FORMAT='txt'）
```

## 設定（環境変数）

| 変数 | 用途 | 既定 |
|---|---|---|
| `SIRIUS_REMINDER_DIR` | 出力先フォルダ | `~/Documents/TUAT/_リマインド` |
| `SIRIUS_REMINDER_FORMAT` | `md` / `txt` | `md` |
| `SIRIUS_REMINDER_AFTER` | 既存ファイルに課題の節が無い時、この見出しの節の直後に入れる（例 `## タスク` / `【予定】`） | ファイルの末尾 |
| `SIRIUS_IGNORE_KEYWORDS` | 課題扱いしない見出し（カンマ区切り。sync-calendar と共通） | なし |

旧版の `SIRIUS_DIARY_DIR` / `SIRIUS_DIARY_AFTER` も同じ意味で読む。

## 動作

- 元データ: `~/.local/share/sirius-fetch/output/{assignments-todo.md, classroom-todo.md}`（`sirius-portal` が生成）。
- **ファイルが無ければ作る**（1行目にタイトル、続けて課題の節）。
- **ファイルがあれば課題の節だけを置き換える**（冪等）。md は `## 📚 課題` から次の `## ` 見出しの手前まで、txt は `【課題】` から次の `【` で始まる行の手前まで。他の内容は残すので、出力先を手持ちのノート（日付名のファイル）のフォルダにしてもよい。
- 行形式:
  - md: `- [ ] **課題名**（科目）〆締切 …  ｜Sakai`／`… ｜Classroom [開く](URL)`
  - txt: `・課題名（科目）〆締切 …  ｜Classroom URL`（Markdown の強調記号は外す）
- 当日に `attend.mjs --list/--history/--notify` を実行していれば、出席状況も課題の節の中に入る（md は `### 🪑 出席`、txt は `（出席）`）。
- 未提出は毎回上書き（提出済みは次回 fetch で `未提出` から消えるので自然に落ちる）。
- `fetch-all`（launchd / タスクスケジューラ）が定期取得の最後に実行する。

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
