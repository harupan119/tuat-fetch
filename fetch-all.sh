#!/bin/zsh
# fetch-all.sh — launchd と 取得.command から呼ぶ macOS 用の入口。本体は fetch-all.mjs（Windows と共通）
#   launchd は最小 PATH で起動するため node を絶対パスで探す。
cd "${0:A:h}" || exit 1
NODE=/opt/homebrew/bin/node
[[ -x $NODE ]] || NODE=/usr/local/bin/node
[[ -x $NODE ]] || NODE=node
exec "$NODE" fetch-all.mjs "$@"
