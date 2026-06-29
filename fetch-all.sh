#!/bin/zsh
# fetch-all.sh — 全ソースを一括取得（launchd定期実行 と ダブルクリック起動 で共用）
#   時間割/休講/お知らせ → Sakai教材 → Classroom教材 → 未提出課題(通知付き)
set -u
cd "${0:A:h}" || exit 1
NODE=/opt/homebrew/bin/node
log() { print -r -- "$(date '+%F %T') $*"; }

# Classroom系: セッション切れ(exit 2)なら無人再ログインして1回だけリトライ
classroom_run() {
  local script="$1"
  "$NODE" "$script" && return 0
  log "… $script 失敗。Classroom再ログインしてリトライ"
  "$NODE" classroom/login.mjs --headless || { log "✗ Classroom再ログイン失敗"; return 1; }
  "$NODE" "$script" || { log "✗ $script リトライも失敗"; return 1; }
}

log "▶ 取得開始"
"$NODE" fetch.mjs              || log "✗ fetch.mjs 失敗"
"$NODE" materials.mjs         || log "✗ materials.mjs 失敗"
classroom_run classroom/materials.mjs || log "✗ classroom/materials.mjs 失敗"
"$NODE" assignments.mjs       || log "✗ assignments.mjs 失敗"
classroom_run classroom/fetch.mjs   || log "✗ classroom/fetch.mjs 失敗"
"$NODE" reminder-daily.mjs    || log "✗ reminder-daily.mjs 失敗"  # 当日のデイリーノートがあれば課題セクション更新
log "✓ 取得完了"
