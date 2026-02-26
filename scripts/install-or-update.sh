#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/Aux0x7F/NK3Mixtape.git}"
BRANCH="${BRANCH:-main}"
TARGET_DIR="${TARGET_DIR:-/opt/nk3mixtape}"
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

RUNTIME_DATA_DIR=""
RUNTIME_EVENTS_FILE=""
RUNTIME_IDENTITY_FILE=""

wait_for_healthz() {
  local url="$1"
  local attempts="${2:-20}"
  local delay_s="${3:-1}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      curl -fsS "$url"
      return 0
    fi
    sleep "$delay_s"
  done
  return 1
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

is_git_repo() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir/.git" ]]
}

service_env_var() {
  local key="$1"
  if ! command -v systemctl >/dev/null 2>&1; then
    return 1
  fi
  run_as_root systemctl show "$SERVICE_NAME" -p Environment --value 2>/dev/null | \
    tr ' ' '\n' | sed -n "s/^${key}=//p" | head -n1
}

ensure_runtime_data_files() {
  local svc_wd=""
  local svc_user=""
  local svc_group=""
  local data_dir=""
  local events_file=""
  local identity_file=""

  if command -v systemctl >/dev/null 2>&1; then
    svc_wd="$(run_as_root systemctl show "$SERVICE_NAME" -p WorkingDirectory --value 2>/dev/null || true)"
    svc_user="$(run_as_root systemctl show "$SERVICE_NAME" -p User --value 2>/dev/null || true)"
    svc_group="$(run_as_root systemctl show "$SERVICE_NAME" -p Group --value 2>/dev/null || true)"
    data_dir="$(service_env_var DATA_DIR || true)"
    events_file="$(service_env_var EVENTS_FILE || true)"
    identity_file="$(service_env_var IDENTITY_FILE || true)"
  fi

  [[ -n "$data_dir" ]] || data_dir="${svc_wd:-$TARGET_DIR/peer-pinner}/data"
  [[ -n "$events_file" ]] || events_file="$data_dir/events.ndjson"
  [[ -n "$identity_file" ]] || identity_file="$data_dir/peer-pinner-identity.json"
  [[ -n "$svc_user" ]] || svc_user="$ACTOR_USER"
  [[ -n "$svc_group" ]] || svc_group="$ACTOR_GROUP"

  run_as_root mkdir -p "$data_dir"
  run_as_root touch "$events_file"
  run_as_root chown -R "$svc_user:$svc_group" "$data_dir" || true
  run_as_root chmod 755 "$data_dir" || true
  run_as_root chmod 640 "$events_file" || true

  RUNTIME_DATA_DIR="$data_dir"
  RUNTIME_EVENTS_FILE="$events_file"
  RUNTIME_IDENTITY_FILE="$identity_file"
}

sync_repo_branch() {
  run_as_actor git -C "$TARGET_DIR" remote set-url origin "$REPO_URL"
  run_as_actor git -C "$TARGET_DIR" fetch origin "$BRANCH" --depth=1
  run_as_actor git -C "$TARGET_DIR" checkout "$BRANCH" >/dev/null 2>&1 || \
    run_as_actor git -C "$TARGET_DIR" checkout -B "$BRANCH"
  local backup_ref="pre-reset-$(date +%Y%m%d%H%M%S)"
  echo "hard syncing repo to origin/$BRANCH (saving previous HEAD as $backup_ref)"
  run_as_actor git -C "$TARGET_DIR" branch "$backup_ref" HEAD >/dev/null 2>&1 || true
  run_as_actor git -C "$TARGET_DIR" reset --hard "origin/$BRANCH"
  run_as_actor git -C "$TARGET_DIR" clean -fdx
}

service_workdir() {
  local file="/etc/systemd/system/${SERVICE_NAME}.service"
  if [[ ! -f "$file" ]]; then
    return 0
  fi
  sed -n 's/^WorkingDirectory=//p' "$file" | head -n1
}

detect_legacy_repo() {
  local -a candidates=()
  local svc_wd=""
  svc_wd="$(service_workdir || true)"

  candidates+=("$TARGET_DIR")
  candidates+=("$HOME/NK3Mixtape")
  candidates+=("/root/NK3Mixtape")
  candidates+=("/opt/NK3Mixtape")
  if [[ -n "$svc_wd" ]]; then
    candidates+=("$(dirname "$svc_wd")")
  fi
  for p in /home/*/NK3Mixtape; do
    candidates+=("$p")
  done

  local seen=""
  local c=""
  for c in "${candidates[@]}"; do
    [[ -n "$c" ]] || continue
    [[ "$seen" == *"|$c|"* ]] && continue
    seen="${seen}|$c|"
    if is_git_repo "$c"; then
      echo "$c"
      return 0
    fi
  done
  return 1
}

prepare_target_dir() {
  local target_parent
  target_parent="$(dirname "$TARGET_DIR")"
  if [[ -e "$TARGET_DIR" && ! -d "$TARGET_DIR/.git" ]]; then
    if [[ -n "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]]; then
      local backup="${TARGET_DIR}.backup.$(date +%s)"
      run_as_root mv "$TARGET_DIR" "$backup"
      echo "moved conflicting target to $backup"
    else
      run_as_root rm -rf "$TARGET_DIR"
    fi
  fi
  run_as_root mkdir -p "$target_parent"
  run_as_root chmod 755 "$target_parent" || true
  if [[ ! -e "$TARGET_DIR" ]]; then
    run_as_root mkdir -p "$TARGET_DIR"
  fi
  run_as_root chown -R "$ACTOR_USER:$ACTOR_GROUP" "$TARGET_DIR"
  run_as_root chmod 755 "$TARGET_DIR" || true
}

migrate_legacy_repo_if_needed() {
  if is_git_repo "$TARGET_DIR"; then
    return 0
  fi
  local legacy=""
  legacy="$(detect_legacy_repo || true)"
  if [[ -z "$legacy" || "$legacy" == "$TARGET_DIR" ]]; then
    return 0
  fi

  echo "found legacy repo at $legacy"
  echo "migrating to $TARGET_DIR"
  run_as_root rm -rf "$TARGET_DIR"
  run_as_root mkdir -p "$(dirname "$TARGET_DIR")"
  if command -v rsync >/dev/null 2>&1; then
    run_as_root rsync -a --delete "$legacy/" "$TARGET_DIR/"
  else
    run_as_root cp -a "$legacy" "$TARGET_DIR"
  fi
  run_as_root chown -R "$ACTOR_USER:$ACTOR_GROUP" "$TARGET_DIR"
}

if ! command -v git >/dev/null 2>&1; then
  install_pkg git
fi
if ! command -v npm >/dev/null 2>&1; then
  install_pkg npm
fi
if ! command -v node >/dev/null 2>&1; then
  install_pkg nodejs
fi

prepare_target_dir
migrate_legacy_repo_if_needed

fresh_install=0
if is_git_repo "$TARGET_DIR"; then
  sync_repo_branch
else
  run_as_root rm -rf "$TARGET_DIR"
  run_as_root mkdir -p "$(dirname "$TARGET_DIR")"
  run_as_actor git clone --depth 1 --branch "$BRANCH" "$REPO_URL" "$TARGET_DIR"
  fresh_install=1
fi

run_as_actor npm --prefix "$TARGET_DIR/peer-pinner" install --omit=dev

run_as_root env \
  PINNER_USER="$ACTOR_USER" \
  PINNER_GROUP="$ACTOR_GROUP" \
  SERVICE_NAME="$SERVICE_NAME" \
  bash "$TARGET_DIR/scripts/setup-peer-pinner.sh"

ensure_runtime_data_files

echo
if [[ "$fresh_install" -eq 1 ]]; then
  echo "installed"
else
  echo "updated"
fi
echo "repo: $TARGET_DIR"
echo "service: sudo systemctl status $SERVICE_NAME --no-pager"
if [[ -n "$RUNTIME_DATA_DIR" ]]; then
  echo "data-dir: $RUNTIME_DATA_DIR"
fi
if [[ -n "$RUNTIME_EVENTS_FILE" ]]; then
  echo "events-file: $RUNTIME_EVENTS_FILE"
fi
if [[ -n "$RUNTIME_IDENTITY_FILE" ]]; then
  echo "identity-file: $RUNTIME_IDENTITY_FILE"
fi
if command -v curl >/dev/null 2>&1; then
  HEALTHZ_URL="${HEALTHZ_URL:-http://127.0.0.1:4848/healthz}"
  if hz="$(wait_for_healthz "$HEALTHZ_URL" 25 1)"; then
    echo "healthz: $hz"
  else
    echo "healthz: unavailable"
    if command -v systemctl >/dev/null 2>&1; then
      echo "service-active: $(systemctl is-active "$SERVICE_NAME" 2>/dev/null || true)"
      echo "recent service logs:"
      journalctl -u "$SERVICE_NAME" -n 20 --no-pager || true
    fi
  fi
fi
