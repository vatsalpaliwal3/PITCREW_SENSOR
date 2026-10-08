#!/usr/bin/env bash
# Constitution 12.1: no URL literals in source. Fails if any are found in src/ or scripts/.
set -u
cd "$(dirname "$0")/.."
pat='localhost|127\.0\.0\.1|onrender\.com|vercel\.app|supabase\.co'
if grep -rnE "$pat" src scripts --include='*.js' --include='*.mjs' --include='*.html' --include='*.css' --include='*.json' --exclude='check_no_hardcoded_urls.sh'; then
  echo "FAIL: hardcoded URL found (see above)"; exit 1
fi
echo "OK: no hardcoded URLs"
