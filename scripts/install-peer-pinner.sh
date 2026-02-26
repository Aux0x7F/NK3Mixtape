#!/usr/bin/env bash
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -n "$SELF_DIR" && -f "$SELF_DIR/update-peer-pinner.sh" ]]; then
  exec bash "$SELF_DIR/update-peer-pinner.sh" "$@"
fi

UPDATE_URL="${UPDATE_URL:-https://raw.githubusercontent.com/Aux0x7F/NK3Mixtape/main/scripts/update-peer-pinner.sh}"
if command -v curl >/dev/null 2>&1; then
  exec bash -c "$(curl -fsSL "$UPDATE_URL")" -- "$@"
fi
if command -v wget >/dev/null 2>&1; then
  exec bash -c "$(wget -qO- "$UPDATE_URL")" -- "$@"
fi

echo "need curl or wget"
exit 1
