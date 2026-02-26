# No Kings Day 3 Mixtape

Static, GitHub Pages-friendly playlist board:
- add title + artist
- optional YouTube URL per entry with inline play/pause
- upvote/downvote (each user has one adjustable vote per entry)
- signed unique name claims (first claim wins per name)
- profile modal with alias, social link, bio
- owner or admin revoke/restore per entry
- admin ban / temp-ban / unban by pubkey
- admin snapshot seeding for fresh users (console)
- no-key paste backup + restore (dpaste)
- shared-worker event cache + service-worker app-shell cache for stronger offline restore

## Quick setup

1. Optionally edit `APP.relays` in `app.js`.
2. Optional migration fallback: set `APP.bootstrapAdminPubkey` (otherwise first admin claim event wins).
3. Optional fresh-client fallback: set `APP.bootstrapBackupUrls` with one or more paste URLs (newest first).
4. Push to GitHub Pages.

Open the page and sign in with:
- alias + password (required, deterministic key derived in-browser)
- login is a splash screen; playlist UI unlocks only after a keypair is available
- session remember is automatic (no checkbox in UI)
- install option appears when browser PWA install criteria are met (`install app` button)

If a name already exists, sign-in asks for that name's password to derive the same keypair.

If no admin exists, signed-in users see a `claim admin` wizard button.  
`download keys` exports identity JSON (includes private key).

Admins can assign/remove other admins from the `admin pubkey` controls.
Admins can ban users (`ban`), temp-ban in minutes (`temp`), and `unban`.
Snapshot publish is hidden from UI and exposed via browser console helper `window.NK3Admin.snapshot()`.
Any signed-in user can ask peers for a fresh snapshot with `window.NK3Admin.requestSnapshot()`.
Profile is under the `☰` menu as a modal. Clicking a user label opens their profile modal.

Limit: browser workers are not truly always-on. If every client is closed/offline and no relay/backup endpoint is reachable, no browser-only setup can fully recover by itself.

## Optional self-hosted pinning relay (Linux)

This repo includes a minimal Node peer relay that:
- subscribes upstream relays for your NK3 event kinds/tag,
- stores all seen events in `relay/data/events.ndjson`,
- serves them to downstream Nostr consumers over websocket `REQ`,
- republishes local downstream `EVENT` writes back upstream.
- auto-creates a relay identity keypair on first run and persists it at `relay/data/relay-identity.json`
- gives that relay identity a deterministic 3-word alias from its pubkey (override with `RELAY_ALIAS=...`)
- keeps app-level logical indexes (admin set, alias ownership, latest admin snapshot)
- supports lightweight websocket logical queries:
  `["NK3_USER_EXISTS","req-id","alias"]`
  `["NK3_SNAPSHOT_LATEST","req-id"]`
  `["NK3_STATE","req-id"]`
- on `34132` snapshot-request events, rebroadcasts latest cached admin snapshot to downstream/upstream consumers

One-liner (from repo root):
`sudo SERVICE_NAME=nk3-pinning-relay PORT=4848 HOST=0.0.0.0 UPSTREAM_RELAYS="wss://relay.damus.io,wss://relay.primal.net,wss://nos.lol" bash scripts/setup-pinning-relay.sh`

Fresh host clone + install one-liner:
`git clone <YOUR_REPO_URL> nk3 && cd nk3 && sudo bash scripts/setup-pinning-relay.sh`

1. On your Linux host, clone this repo.
2. Run:
   `sudo bash scripts/setup-pinning-relay.sh`
3. Point client relays in `app.js` to your relay URL (prefer `wss://` behind TLS/reverse proxy).

Files:
- `relay/pinning-relay.js` (upstream mirror + websocket relay + persistent event log)
- `relay/package.json` (`ws` dependency)
- `scripts/setup-pinning-relay.sh` (install deps + systemd service)

`snapshot + paste`:
- signs snapshot event
- uploads recovery JSON to dpaste (no API key/account)
- publishes to configured relays
- copies a restore link (`?backup=<url>`) to clipboard

Recovery sources:
- `?backup=<url>` query param
- last saved backup URL in localStorage
- `APP.bootstrapBackupUrls` fallbacks in app config
- local cached recovery JSON

## Event model

- `34123` entry
- `34124` vote
- `34125` mod (`revoke` / `restore`, signed by entry owner or active admin)
- `34126` snapshot seed (active admin pubkey only)
- `34127` admin claim (`admin_pubkey` self-claim)
- `34128` admin role (`grant` / `revoke` target pubkey)
- `34129` user moderation (`ban` / `temp_ban` / `unban` target pubkey)
- `34130` name claim (`name`, first claim wins)
- `34131` profile (`name`, `social`, `bio`)
- `34132` snapshot request (`request_id`; active admins auto-respond with a fresh snapshot)

All events use tag `["t","no-kings-playlist"]`.
