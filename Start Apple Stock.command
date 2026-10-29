#!/bin/zsh
set -e
cd -- "${0:A:h}"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  print 'Install Node.js 22 or newer, then open this launcher again.'
  read '?Press Return to close.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  npm ci
  npx playwright install chromium
fi
print 'Apple Stock is starting. Open http://127.0.0.1:4321'
print 'Keep this window open. Press Control-C to stop monitoring.'
exec npm start
