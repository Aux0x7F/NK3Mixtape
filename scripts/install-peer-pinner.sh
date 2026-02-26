#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Aux0x7F/NK3Mixtape.git}"
BRANCH="${BRANCH:-main}"
TARGET_DIR="${TARGET_DIR:-$HOME/NK3Mixtape}"

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  ROOT_CMD=()
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required (or run this script as root)"
    exit 1
  fi
  ROOT_CMD=(sudo)
fi

install_pkg() {
  local pkg="$1"
  if command -v apt-get >/dev/null 2>&1; then
    "${ROOT_CMD[@]}" apt-get update
    "${ROOT_CMD[@]}" apt-get install -y "$pkg"
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    "${ROOT_CMD[@]}" dnf install -y "$pkg"
    return
  fi
  if command -v yum >/dev/null 2>&1; then
    "${ROOT_CMD[@]}" yum install -y "$pkg"
    return
  fi
  echo "missing package manager; install $pkg manually"
  exit 1
}

if ! command -v git >/dev/null 2>&1; then
  install_pkg git
fi

if [[ -e "$TARGET_DIR" && ! -d "$TARGET_DIR/.git" ]]; then
  echo "target exists but is not a git repo: $TARGET_DIR"
  echo "set TARGET_DIR to another path and rerun"
  exit 1
fi

if [[ -d "$TARGET_DIR/.git" ]]; then
  git -C "$TARGET_DIR" fetch origin "$BRANCH" --depth=1
  git -C "$TARGET_DIR" checkout "$BRANCH"
  git -C "$TARGET_DIR" pull --ff-only origin "$BRANCH"
else
  mkdir -p "$(dirname "$TARGET_DIR")"
  git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
fi

"${ROOT_CMD[@]}" bash "$TARGET_DIR/scripts/setup-peer-pinner.sh"

echo
echo "install complete"
echo "repo: $TARGET_DIR"
echo "service: sudo systemctl status nk3-peer-pinner --no-pager"
