#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/nk3mixtape}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-nk3-peer-pinner}"

if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
  ROOT_CMD=()
  ACTOR_USER="${SUDO_USER:-$(logname 2>/dev/null || id -un)}"
else
  if ! command -v sudo >/dev/null 2>&1; then
    echo "sudo is required (or run this script as root)"
    exit 1
  fi
  ROOT_CMD=(sudo)
  ACTOR_USER="$(id -un)"
fi
ACTOR_GROUP="$(id -gn "$ACTOR_USER" 2>/dev/null || echo "$ACTOR_USER")"

run_as_root() {
  "${ROOT_CMD[@]}" "$@"
}

run_as_actor() {
  if [[ "${EUID:-$(id -u)}" -eq 0 && "$ACTOR_USER" != "root" ]]; then
    if command -v sudo >/dev/null 2>&1; then
      sudo -u "$ACTOR_USER" -H "$@"
    elif command -v runuser >/dev/null 2>&1; then
      runuser -u "$ACTOR_USER" -- "$@"
    else
      echo "need sudo or runuser to switch to $ACTOR_USER"
      exit 1
    fi
    return
  fi
  "$@"
}

install_pkg() {
  local pkg="$1"
  if command -v apt-get >/dev/null 2>&1; then
    run_as_root apt-get update
    run_as_root apt-get install -y "$pkg"
    return
  fi
  if command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y "$pkg"
    return
  fi
  if command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y "$pkg"
    return
  fi
  echo "missing package manager; install $pkg manually"
  exit 1
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
  echo "missing repo at $REPO_DIR"
  echo "run installer first:"
  echo "curl -fsSL https://raw.githubusercontent.com/Aux0x7F/NK3Mixtape/main/scripts/install-peer-pinner.sh | bash"
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  install_pkg git
fi
if ! command -v npm >/dev/null 2>&1; then
  install_pkg npm
fi
if ! command -v node >/dev/null 2>&1; then
  install_pkg nodejs
fi

run_as_root chown -R "$ACTOR_USER:$ACTOR_GROUP" "$REPO_DIR"

run_as_actor git -C "$REPO_DIR" fetch origin "$BRANCH" --depth=1
run_as_actor git -C "$REPO_DIR" checkout "$BRANCH"
run_as_actor git -C "$REPO_DIR" pull --ff-only origin "$BRANCH"
run_as_actor npm --prefix "$REPO_DIR/peer-pinner" install --omit=dev

run_as_root systemctl daemon-reload
run_as_root systemctl restart "$SERVICE_NAME"

echo
echo "updated"
echo "repo: $REPO_DIR"
echo "service: sudo systemctl status $SERVICE_NAME --no-pager"
if command -v curl >/dev/null 2>&1; then
  echo "healthz: $(curl -fsS http://127.0.0.1:4848/healthz || echo unavailable)"
fi
