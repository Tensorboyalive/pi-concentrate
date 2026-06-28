#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CONCENTRATE_API_KEY="${CONCENTRATE_API_KEY:-dummy}" pi -e "$ROOT" --list-models | grep -E 'concentrate[[:space:]]+glm-5\.2' >/dev/null

if [[ "${RUN_LIVE_CONCENTRATE_SMOKE:-}" == "1" ]]; then
  pi -e "$ROOT" --model 'concentrate/glm-5.2:low' --no-session 'reply exactly: ok' | grep -Fx 'ok' >/dev/null
else
  echo "skipping live Concentrate smoke; set RUN_LIVE_CONCENTRATE_SMOKE=1 to enable"
fi

echo "smoke ok"
