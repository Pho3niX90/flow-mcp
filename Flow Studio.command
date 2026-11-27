#!/bin/zsh
# Double-click to start the Flow Studio panel. Close this window to stop it.
cd "$(dirname "$0")" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
[ -d dist ] || npm run build || exit 1
node dist/studio.js
