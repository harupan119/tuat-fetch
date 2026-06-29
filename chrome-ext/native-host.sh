#!/bin/bash
# Chrome Native Messaging host のラッパー（Chromeは最小PATHで起動するためnodeは絶対パス）
# node のパスは環境に合わせて。Homebrew(Apple Silicon)の既定は /opt/homebrew/bin/node
exec /opt/homebrew/bin/node "$(dirname "$0")/native-host.mjs"
