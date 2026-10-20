#!/usr/bin/env bash
# 互換用の入口。本体は form_tools.mjs（macOS / Windows 共通）。使い方は form_tools.mjs の先頭を参照
exec node "$(dirname "$0")/form_tools.mjs" "$@"
