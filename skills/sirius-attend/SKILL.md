---
name: sirius-attend
description: "Sakai(SIRIUS-LMS)の出席（テスト・クイズに出される『第N回出席』『第N回 出席確認』）を半自動で登録する。『出席して』『出席登録』『出席クイズ出して』『今日の出席』等で使う。実体は ~/Projects/sirius-fetch/attend.mjs。既定では最終の『提出』は本人が押す（--go 指定時のみ全自動）。授業中に本人が教室にいる状態で使うこと。前提: sirius-session。"
---

# Sakai(SIRIUS-LMS) 出席 半自動登録

TUATの出席は**Sakaiの「テスト・クイズ」(samigo)に「第N回出席」「第N回 出席確認」というクイズ**として出される。専用の出席ツールは存在しない。

**受験可能な出席クイズの発見→受験画面を開く（＋コード入力）までを自動化**し、既定では最終の「提出」は本人が押す。

## 全体の流れ

```
①受験可能な「出席」クイズを今学期サイトから探索（今日の曜日の科目を優先）
②headed ブラウザで受験画面を開く
③コードが分かっていれば --code で自動入力
④本人が「提出」を押す（--go 指定時のみ自動提出）
```

## コマンド

```bash
cd ~/Projects/sirius-fetch
node attend.mjs --list                  # 受験可能な出席クイズ一覧（読み取りのみ・headless）
node attend.mjs --history               # 提出済みの出席履歴を科目別に一覧（全科目・読み取りのみ）
node attend.mjs --notify                # 受験可能クイズがあればデスクトップ通知（watch用・重複通知なし）
node attend.mjs                         # 候補1件なら受験画面を開く（開始は押さない）
node attend.mjs --course "<科目名の一部>" # 科目名で絞る（部分一致）
node attend.mjs --code 1234             # 開始→コード入力まで自動。提出は本人
node attend.mjs --go                    # コード不要のクイズを提出まで全自動
node attend.mjs --code 1234 --go        # コード入力＋提出まで全自動
node attend.mjs --choice 1 --go         # 選択式で1番目の選択肢を選んで提出
```

- `--go` 単体でも「開始→提出」まで自動。ただし**入力欄があるのに `--code` が無い場合は自動提出しない**（空回答防止で本人に委ねる）
- 選択式は `--choice N`（1始まり）。選択肢が1個だけなら `--go` で自動選択。複数あって未指定なら本人に委ねる

## 通知watch（定期実行・通知のみで自動提出はしない）

平日8:00-18:30に15分おきで受験可能クイズを監視し、公開されたらデスクトップ通知する（`SIRIUS_WATCH=1`ガード・`attend-state.json`で同一クイズは再通知しない）。**通知のみ。提出は本人が `node attend.mjs --go` 等で実行**。

- macOS: `launchd/com.example.sirius-attend-watch.plist.example` のパスを置換して `~/Library/LaunchAgents/` に置き、ロード（README の手順）。
- Windows: `windows\install-tasks.ps1` がタスク `sirius-fetch-attend-watch` を登録（`SIRIUS_WATCH=1` 付き）。

## リマインド連携

`--list/--history/--notify` 実行時に `~/.local/share/sirius-fetch/output/attendance.md` へサマリを書き出し、`reminder-daily.mjs`（sirius-reminder）が当日更新分をリマインドファイルの課題の節（md は「### 🪑 出席」）に反映する。

- `--title "第13回"` … 同一科目に複数候補があるときの絞り込み
- `--all` … 今日の曜日以外の科目も候補に含める（既定は今日の曜日を優先、無ければ自動で全科目）
- 授業中に教員がコード（番号・キーワード）を提示する科目では `--code` に渡す。コード不要の科目はそのまま提出

## 使い方の典型（Claudeの動き）

1. ユーザー「出席して」→ まず `--list` で候補を提示
2. コードが要るクイズならユーザーにコードを聞く
3. `node attend.mjs [--course ...] [--code ...]` で受験画面を開き、**提出は本人に委ねる**
4. `--go` はユーザーが明示的に全自動を求めたときだけ

## 技術メモ（attend.mjs の攻略法）

- サイト列挙は `/direct/site.json`、ツールは `/direct/site/<id>/pages.json` で `sakai.samigo` を特定
- **一覧確認はHTTPのみ**：`GET /portal/tool/<配置id>/jsf/index/mainIndex` でJSFのHTMLを直接取得（ブラウザは対象1サイトの操作時だけ起動）。pages.json の url はホームページ共用のことがあるので配置id直指定
- 受験可能クイズ＝`selectTable`（テストを受験）内の `takeAssessment` リンク（提出済みには無い）。操作時のページは iframe 内（`/jsf/` を含むframe）
- 開始ボタンは `input[value*="開始"]`、提出は「採点のために提出」→確認ページの「提出」→完了ページの「続ける」まで押して一覧に戻る
- IP制限ページ（「アクセスが拒否されました」）はクリック直後と開始直後に検知して exit 3
- 各ステップで `~/.local/share/sirius-fetch/inspect/attend-*.png` にスクショを残す
- セッションは storageState 使用。切れていたら `sirius-session` で再ログイン
- 開始〜提出の全自動（--go）は実際の出席（回答不要型）で動作確認済み。コード入力型（--code）は未検証なので初回は目視確認を推奨
- ⚠️ クイズに**IP制限**が設定されている場合がある（「アクセスが拒否されました…IPアドレスには，テストへのアクセス権が設定されていません」）。学内Wi-Fi（TUAT-WiFi/eduroam）から実行すること。テザリング・VPNでは弾かれる。この制限の迂回はしない（不正出席）

## 安全原則

- **教室にいる授業の出席にだけ使う**（不在時の代理出席は不正行為。自動化はあくまで操作の省力化）
- 既定で最終「提出」は本人が押す。`--go` は明示要求時のみ
- cron / launchd / タスクスケジューラへの組み込み禁止（無人出席になるため。`--notify` だけは可）
- `--list` は読み取りのみで安全。迷ったらまず `--list`
