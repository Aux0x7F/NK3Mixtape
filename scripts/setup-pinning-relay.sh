#!/usr/bin/env bash
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "run as root: sudo bash scripts/setup-pinning-relay.sh"
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_DIR="$ROOT_DIR/relay"
SERVICE_NAME="${SERVICE_NAME:-nk3-pinning-relay}"
RELAY_USER="${RELAY_USER:-$(logname 2>/dev/null || echo "$SUDO_USER")}"
RELAY_USER="${RELAY_USER:-$(id -un)}"
RELAY_GROUP="${RELAY_GROUP:-$RELAY_USER}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-4848}"
DATA_DIR="${DATA_DIR:-$RELAY_DIR/data}"
UPSTREAM_RELAYS="${UPSTREAM_RELAYS:-wss://relay.damus.io,wss://relay.primal.net,wss://nos.lol}"
APP_TAG="${APP_TAG:-no-kings-playlist}"
APP_KINDS="${APP_KINDS:-34123,34124,34125,34126,34127,34128,34129,34130,34131,34132}"
IDENTITY_FILE="${IDENTITY_FILE:-$DATA_DIR/relay-identity.json}"
RELAY_ALIAS="${RELAY_ALIAS:-}"

echo "root:      $ROOT_DIR"
echo "relay dir: $RELAY_DIR"
echo "user:      $RELAY_USER:$RELAY_GROUP"
echo "bind:      $HOST:$PORT"
echo "data dir:  $DATA_DIR"
echo "identity:  $IDENTITY_FILE"
echo "upstream:  $UPSTREAM_RELAYS"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    apt-get install -y nodejs npm
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y nodejs npm
  elif command -v yum >/dev/null 2>&1; then
    yum install -y nodejs npm
  else
    echo "node/npm not found, install Node.js 18+ manually"
    exit 1
  fi
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Node.js 18+ required, found $(node -v)"
  exit 1
fi

mkdir -p "$DATA_DIR"
chown -R "$RELAY_USER:$RELAY_GROUP" "$RELAY_DIR"

if command -v sudo >/dev/null 2>&1; then
  sudo -u "$RELAY_USER" npm --prefix "$RELAY_DIR" install --omit=dev
else
  runuser -u "$RELAY_USER" -- npm --prefix "$RELAY_DIR" install --omit=dev
fi

NODE_BIN="$(command -v node)"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=NK3 Pinning Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RELAY_USER
Group=$RELAY_GROUP
WorkingDirectory=$RELAY_DIR
Environment=HOST=$HOST
Environment=PORT=$PORT
Environment=DATA_DIR=$DATA_DIR
Environment=UPSTREAM_RELAYS=$UPSTREAM_RELAYS
Environment=APP_TAG=$APP_TAG
Environment=APP_KINDS=$APP_KINDS
Environment=IDENTITY_FILE=$IDENTITY_FILE
Environment=RELAY_ALIAS=$RELAY_ALIAS
ExecStart=$NODE_BIN pinning-relay.js
Restart=always
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=$DATA_DIR

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now "$SERVICE_NAME"

echo
echo "service: systemctl status $SERVICE_NAME"
echo "logs:    journalctl -u $SERVICE_NAME -f"
echo "identity file: $IDENTITY_FILE"
echo
echo "relay endpoint: ws://$(hostname -I 2>/dev/null | awk '{print $1}' || echo 'SERVER_IP'):$PORT"
echo "For public clients, put this behind TLS and use wss://"
