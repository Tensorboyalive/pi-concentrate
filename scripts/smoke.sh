#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pi -e "$ROOT" --list-models | grep -E 'concentrate[[:space:]]+glm-5\.2' >/dev/null

if [[ -n "${CONCENTRATE_API_KEY:-}" ]]; then
  pi -e "$ROOT" --model 'concentrate/glm-5.2:high' --no-session 'reply exactly: ok' | grep -Fx 'ok' >/dev/null
fi

echo "smoke ok"
