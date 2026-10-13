#!/usr/bin/env bash
# Spectrum CPR booking — start on macOS or Linux.
set -euo pipefail
cd "$(dirname "$0")"

echo
echo "  Spectrum CPR + First Aid — booking system"
echo "  ========================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  Node.js is not installed. Get the LTS build from https://nodejs.org"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "  Node 22 or newer is required (found $(node --version))."
  echo "  The database uses Node's built-in SQLite, added in 22.5."
  exit 1
fi

[ -d node_modules ] || { echo "  First run — installing dependencies..."; npm install --no-audit --no-fund; echo; }
[ -f data/booking.db ] || { echo "  Setting up the database..."; npm run seed; echo; }

if [ ! -f admin-token.txt ]; then
  node -e "console.log(require('crypto').randomBytes(10).toString('hex'))" > admin-token.txt
  echo "  Created an admin token — see admin-token.txt"
  echo
fi
export ADMIN_TOKEN="$(cat admin-token.txt)"

echo "  Booking page:  http://localhost:3000"
echo "  Admin page:    http://localhost:3000/admin.html"
echo
echo "  Admin token:   $ADMIN_TOKEN"
echo
echo "  Press Ctrl+C to stop."
echo

npm start
