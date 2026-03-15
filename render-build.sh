#!/bin/bash
set -e
echo "==> Node $(node -v) | $(uname -s)"

rm -f yarn.lock package-lock.json

# MUST be false — we need puppeteer to download bundled Chromium
export PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false
export PUPPETEER_CHROMIUM_REVISION=""

yarn install --no-lockfile

# Print where Chromium landed so we can see it in logs
node -e "
  const p = require('puppeteer');
  const bin = p.executablePath();
  const fs = require('fs');
  console.log('Chromium path:', bin);
  console.log('Chromium exists:', fs.existsSync(bin));
" 2>&1

echo "==> Build complete"
