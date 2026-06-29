#!/bin/zsh
# 取得.command — Finderでダブルクリックすると全取得を実行する
"${0:A:h}/fetch-all.sh"
print -r -- ""
print -r -- "完了。このウィンドウは Enter で閉じます。"
read
