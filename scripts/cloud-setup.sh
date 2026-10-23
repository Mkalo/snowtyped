#!/usr/bin/env bash
# Cloud agent setup: install the pinned pnpm, then dependencies.
set -euo pipefail
cd "$(dirname "$0")/.."

npm install --global "$(node -p "require('./package.json').packageManager")"
pnpm install --frozen-lockfile
