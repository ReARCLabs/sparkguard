#!/bin/sh
# Builds a fresh demo workspace and clears Sparkguard state for it, so the demo
# starts from zero every time. Usage: scripts/demo-setup.sh [dir]
set -eu
DIR="${1:-$HOME/sparkguard-demo}"
HERE="$(cd "$(dirname "$0")" && pwd)"
rm -rf "$DIR"
mkdir -p "$DIR/prisma/migrations" "$DIR/src"
cd "$DIR"
cat > prisma/migrations/0001_init.sql <<'SQL'
-- 0001_init.sql (applied in production on Oct 12)
CREATE TABLE customers (
  id serial PRIMARY KEY,
  name text NOT NULL
);
SQL
cat > src/math.js <<'JS'
export function add(a, b) {
  return a - b; // bug: should be a + b
}
JS
printf '# acme-billing\nDemo workspace for Sparkguard.\n' > README.md
git init -q && git add -A && git -c user.name=demo -c user.email=demo@example.com commit -qm "initial"
# forget any rules and snapshots from earlier demo runs of this path
node "$HERE/../bin/sparkguard.js" reset-project >/dev/null 2>&1 || true
echo "demo workspace ready: $DIR"
