#!/bin/bash
# Chrome Native Messaging host のラッパー（macOS。Chromeは最小PATHで起動するためnodeは絶対パスで探す）
#   Windows は native-host.cmd を使う（windows/install-native-host.ps1 が登録する）。
NODE=/opt/homebrew/bin/node
[ -x "$NODE" ] || NODE=/usr/local/bin/node
exec "$NODE" "$(dirname "$0")/native-host.mjs"
