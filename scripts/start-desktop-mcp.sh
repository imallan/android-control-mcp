#!/usr/bin/env sh
set -eu

repo_dir="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"

exec node "$repo_dir/desktop-mcp/src/server.ts"
