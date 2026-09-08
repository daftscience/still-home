#!/bin/sh
# Non-blocking webOS Homebrew boot hook. A package symlink makes uninstall safe.
(
  attempt=0
  while [ "$attempt" -lt 3 ]; do
    reply=$( (sleep 12) | luna-send -n 1 -w 10000 luna://com.tomperry.stillhome.service/startup '{}' 2>/dev/null)
    case "$reply" in *'"returnValue": true'*|*'"returnValue":true'*) exit 0 ;; esac
    attempt=$((attempt + 1))
    sleep 3
  done
) >/dev/null 2>&1 &
exit 0
