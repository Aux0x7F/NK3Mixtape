const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const WebSocket = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 4848);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const EVENTS_FILE = path.join(DATA_DIR, "events.ndjson");
const IDENTITY_FILE = process.env.IDENTITY_FILE || path.join(DATA_DIR, "relay-identity.json");
const INFO_NAME = process.env.RELAY_NAME || "NK3 Peer Relay";
const INFO_DESC = process.env.RELAY_DESCRIPTION || "Mirrors + pins NK3 signed events for downstream Nostr consumers";
const RELAY_PUBKEY_OVERRIDE = process.env.RELAY_PUBKEY || "";
const RELAY_ALIAS_OVERRIDE = process.env.RELAY_ALIAS || "";
const MAX_REQ_EVENTS = Number(process.env.MAX_REQ_EVENTS || 5000);
const TAG_FILTER = String(process.env.APP_TAG || "no-kings-playlist").trim();
const KINDS_FILTER = parseKinds(process.env.APP_KINDS || "34123,34124,34125,34126,34127,34128,34129,34130,34131,34132");
const UPSTREAM_RELAYS = parseRelays(process.env.UPSTREAM_RELAYS || "wss://relay.damus.io,wss://relay.primal.net,wss://nos.lol");
const UPSTREAM_BACKFILL_LIMIT = Number(process.env.UPSTREAM_BACKFILL_LIMIT || 7000);
const UPSTREAM_RECONNECT_MS = Number(process.env.UPSTREAM_RECONNECT_MS || 2500);
const KINDS = {
  snapshot: 34126,
  adminClaim: 34127,
  adminRole: 34128,
  nameClaim: 34130,
  snapshotRequest: 34132,
};

if (!Number.isFinite(PORT) || PORT <= 0) {
  throw new Error(`invalid PORT ${process.env.PORT}`);
}
if (!Number.isFinite(MAX_REQ_EVENTS) || MAX_REQ_EVENTS <= 0) {
  throw new Error(`invalid MAX_REQ_EVENTS ${process.env.MAX_REQ_EVENTS}`);
}

fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, "", { encoding: "utf8" });
const relayIdentity = loadOrCreateRelayIdentity(IDENTITY_FILE, RELAY_ALIAS_OVERRIDE);
const RELAY_ALIAS = RELAY_ALIAS_OVERRIDE || relayIdentity.alias;
const INFO_PUBKEY = RELAY_PUBKEY_OVERRIDE || relayIdentity.pubkey;

const eventsById = new Map();
const ordered = [];
let orderedDirty = false;
const writeStream = fs.createWriteStream(EVENTS_FILE, { flags: "a" });

const upstreams = new Map();
const model = {
  admin: { pubkey: "", claimEvent: null },
  admins: new Set(),
  adminClaims: [],
  adminRoleEvents: [],
  nameClaimEvents: [],
  nameOwnerByName: new Map(),
  nameByPubkey: new Map(),
  snapshotEvents: [],
  snapshot: null,
  snapshotRequestsSeen: new Set(),
};

loadEvents();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const accept = String(req.headers.accept || "");
  if (url.pathname === "/healthz") {
    const upstream = [];
    for (const [relay, client] of upstreams.entries()) {
      upstream.push({ relay, connected: Boolean(client.connected) });
    }
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      ok: true,
      events: eventsById.size,
      upstream,
      relay_identity: {
        alias: RELAY_ALIAS,
        pubkey: INFO_PUBKEY,
      },
      logical: resolveLogicalState(),
    }));
    return;
  }
  if (accept.includes("application/nostr+json")) {
    res.writeHead(200, {
      "content-type": "application/nostr+json; charset=utf-8",
      "access-control-allow-origin": "*",
    });
    res.end(JSON.stringify({
      name: INFO_NAME,
      description: INFO_DESC,
      pubkey: INFO_PUBKEY,
      contact: RELAY_ALIAS,
      software: "nk3-peer-relay",
      version: "0.2.0",
      supported_nips: [1, 11],
      limitation: {
        max_limit: MAX_REQ_EVENTS,
      },
    }));
    return;
  }
  res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
  res.end("nk3 peer relay\n");
});

const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws) => {
  const subs = new Map();
  ws._nk3Subs = subs;

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      sendNotice(ws, "invalid json");
      return;
    }
    if (!Array.isArray(msg) || msg.length === 0) {
      sendNotice(ws, "invalid frame");
      return;
    }
    const cmd = String(msg[0] || "");
    if (cmd === "EVENT") {
      const ev = msg[1];
      if (!isEventShape(ev)) {
        wsSend(ws, ["OK", String(ev?.id || ""), false, "invalid event shape"]);
        return;
      }
      if (eventsById.has(ev.id)) {
        wsSend(ws, ["OK", ev.id, true, "duplicate: already stored"]);
        return;
      }
      storeEvent(ev);
      wsSend(ws, ["OK", ev.id, true, "stored"]);
      publishToUpstreams(ev, "");
      broadcastEvent(ev);
      maybeShareSnapshotForRequest(ev, "");
      return;
    }
    if (cmd === "REQ") {
      const subId = String(msg[1] || "");
      if (!subId) {
        sendNotice(ws, "REQ needs sub id");
        return;
      }
      const filtersRaw = msg.slice(2);
      const filters = filtersRaw.length > 0 ? filtersRaw.filter((x) => x && typeof x === "object") : [{}];
      subs.set(subId, filters);
      sendBacklog(ws, subId, filters);
      wsSend(ws, ["EOSE", subId]);
      return;
    }
    if (cmd === "CLOSE") {
      const subId = String(msg[1] || "");
      subs.delete(subId);
      return;
    }
    if (cmd === "NK3_USER_EXISTS") {
      const reqId = String(msg[1] || "");
      const alias = String(msg[2] || "");
      wsSend(ws, ["NK3_USER_EXISTS", reqId, resolveUserExists(alias)]);
      return;
    }
    if (cmd === "NK3_SNAPSHOT_LATEST") {
      const reqId = String(msg[1] || "");
      wsSend(ws, ["NK3_SNAPSHOT_LATEST", reqId, resolveLatestSnapshot()]);
      return;
    }
    if (cmd === "NK3_STATE") {
      const reqId = String(msg[1] || "");
      wsSend(ws, ["NK3_STATE", reqId, resolveLogicalState()]);
      return;
    }
    sendNotice(ws, `unsupported cmd ${cmd}`);
  });

  ws.on("close", () => {
    subs.clear();
  });
});

startUpstreamMirrors();

server.listen(PORT, HOST, () => {
  console.log(`nk3 peer relay listening ws://${HOST}:${PORT}`);
  console.log(`relay identity @${RELAY_ALIAS} ${shortKey(INFO_PUBKEY)} (${IDENTITY_FILE})`);
  if (UPSTREAM_RELAYS.length > 0) {
    console.log(`upstream mirrors: ${UPSTREAM_RELAYS.join(", ")}`);
  }
});

const shutdown = () => {
  try {
    writeStream.end();
  } catch {
    // ignore
  }
  for (const client of upstreams.values()) {
    clearTimeout(client.retryTimer);
    try {
      client.ws?.close();
    } catch {
      // ignore
    }
  }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function startUpstreamMirrors() {
  for (const relay of UPSTREAM_RELAYS) {
    connectUpstream(relay);
  }
}

function connectUpstream(relay) {
  const existing = upstreams.get(relay);
  if (existing?.ws && (existing.ws.readyState === WebSocket.CONNECTING || existing.ws.readyState === WebSocket.OPEN)) return;

  const client = {
    relay,
    ws: null,
    connected: false,
    retryTimer: null,
    subId: `nk3-sync-${Math.random().toString(36).slice(2, 10)}`,
  };
  upstreams.set(relay, client);

  const ws = new WebSocket(relay);
  client.ws = ws;

  ws.on("open", () => {
    client.connected = true;
    wsSend(ws, ["REQ", client.subId, buildMirrorFilter()]);
    console.log(`upstream connected ${relay}`);
  });

  ws.on("message", (buf) => {
    let msg;
    try {
      msg = JSON.parse(String(buf));
    } catch {
      return;
    }
    if (!Array.isArray(msg) || msg.length === 0) return;
    const cmd = String(msg[0] || "");
    if (cmd === "EVENT") {
      const ev = msg[2];
      if (!isEventShape(ev)) return;
      if (eventsById.has(ev.id)) return;
      storeEvent(ev);
      broadcastEvent(ev);
      maybeShareSnapshotForRequest(ev, relay);
    }
  });

  ws.on("error", () => {
    // handled by close + reconnect
  });

  ws.on("close", () => {
    client.connected = false;
    try {
      wsSend(ws, ["CLOSE", client.subId]);
    } catch {
      // ignore
    }
    scheduleReconnect(relay);
  });
}

function scheduleReconnect(relay) {
  const client = upstreams.get(relay);
  if (!client) return;
  clearTimeout(client.retryTimer);
  client.retryTimer = setTimeout(() => {
    connectUpstream(relay);
  }, UPSTREAM_RECONNECT_MS);
}

function buildMirrorFilter() {
  const filter = {
    "#t": [TAG_FILTER],
    kinds: KINDS_FILTER,
    limit: Math.max(1, Math.min(MAX_REQ_EVENTS, UPSTREAM_BACKFILL_LIMIT)),
  };
  return filter;
}

function loadEvents() {
  const raw = fs.readFileSync(EVENTS_FILE, "utf8");
  if (!raw) return;
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const ev = JSON.parse(t);
      if (!isEventShape(ev)) continue;
      if (eventsById.has(ev.id)) continue;
      eventsById.set(ev.id, ev);
      ordered.push(ev);
      ingestDerivedEvent(ev);
    } catch {
      // Ignore malformed line.
    }
  }
  orderedDirty = true;
  ensureOrderedAsc();
  recomputeDerived();
  console.log(`loaded ${ordered.length} events from ${EVENTS_FILE}`);
}

function ensureOrderedAsc() {
  if (!orderedDirty) return;
  ordered.sort(compareEventAsc);
  orderedDirty = false;
}

function compareEventAsc(a, b) {
  if (a.created_at !== b.created_at) return a.created_at - b.created_at;
  return String(a.id || "").localeCompare(String(b.id || ""));
}

function storeEvent(ev) {
  if (eventsById.has(ev.id)) return false;
  eventsById.set(ev.id, ev);
  if (ordered.length > 0 && compareEventAsc(ordered[ordered.length - 1], ev) > 0) {
    orderedDirty = true;
  }
  ordered.push(ev);
  writeStream.write(`${JSON.stringify(ev)}\n`);
  ingestDerivedEvent(ev);
  recomputeDerived();
  return true;
}

function publishToUpstreams(ev, skipRelay) {
  for (const [relay, client] of upstreams.entries()) {
    if (skipRelay && relay === skipRelay) continue;
    const ws = client.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) continue;
    wsSend(ws, ["EVENT", ev]);
  }
}

function sendBacklog(ws, subId, filters) {
  ensureOrderedAsc();
  const seen = new Set();
  const merged = [];
  for (const filter of filters) {
    const limitRaw = Number(filter.limit);
    const limit = Number.isFinite(limitRaw) ? Math.max(0, Math.min(MAX_REQ_EVENTS, Math.floor(limitRaw))) : MAX_REQ_EVENTS;
    if (limit <= 0) continue;
    let count = 0;
    for (let i = ordered.length - 1; i >= 0; i -= 1) {
      const ev = ordered[i];
      if (!matchesFilter(ev, filter)) continue;
      if (!seen.has(ev.id)) {
        seen.add(ev.id);
        merged.push(ev);
      }
      count += 1;
      if (count >= limit) break;
    }
  }
  merged.sort((a, b) => (b.created_at !== a.created_at ? b.created_at - a.created_at : String(b.id).localeCompare(String(a.id))));
  for (const ev of merged) wsSend(ws, ["EVENT", subId, ev]);
}

function broadcastEvent(ev) {
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    const subs = client._nk3Subs;
    if (!subs || !(subs instanceof Map)) continue;
    for (const [subId, filters] of subs.entries()) {
      if (matchesAnyFilter(ev, filters)) {
        wsSend(client, ["EVENT", subId, ev]);
      }
    }
  }
}

function matchesAnyFilter(ev, filters) {
  if (!Array.isArray(filters) || filters.length === 0) return true;
  return filters.some((f) => matchesFilter(ev, f));
}

function matchesFilter(ev, filter) {
  if (!filter || typeof filter !== "object") return true;
  if (Array.isArray(filter.ids) && filter.ids.length > 0) {
    const ok = filter.ids.some((x) => String(ev.id || "").startsWith(String(x || "")));
    if (!ok) return false;
  }
  if (Array.isArray(filter.authors) && filter.authors.length > 0) {
    const ok = filter.authors.some((x) => String(ev.pubkey || "").startsWith(String(x || "")));
    if (!ok) return false;
  }
  if (Array.isArray(filter.kinds) && filter.kinds.length > 0) {
    const kinds = new Set(filter.kinds.map((x) => Number(x)));
    if (!kinds.has(Number(ev.kind))) return false;
  }
  if (Number.isFinite(Number(filter.since)) && Number(ev.created_at) < Number(filter.since)) return false;
  if (Number.isFinite(Number(filter.until)) && Number(ev.created_at) > Number(filter.until)) return false;

  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith("#")) continue;
    const tagName = key.slice(1);
    if (!Array.isArray(values) || values.length === 0) continue;
    const valueSet = new Set(values.map((v) => String(v)));
    let tagMatch = false;
    for (const tag of ev.tags || []) {
      if (!Array.isArray(tag) || String(tag[0] || "") !== tagName) continue;
      for (let i = 1; i < tag.length; i += 1) {
        if (valueSet.has(String(tag[i]))) {
          tagMatch = true;
          break;
        }
      }
      if (tagMatch) break;
    }
    if (!tagMatch) return false;
  }
  return true;
}

function isEventShape(ev) {
  if (!ev || typeof ev !== "object") return false;
  if (!isStr(ev.id) || !isStr(ev.pubkey) || !isStr(ev.sig) || !isStr(ev.content)) return false;
  if (!Number.isFinite(Number(ev.kind)) || !Number.isFinite(Number(ev.created_at))) return false;
  if (!Array.isArray(ev.tags)) return false;
  return true;
}

function isStr(v) {
  return typeof v === "string";
}

function wsSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendNotice(ws, msg) {
  wsSend(ws, ["NOTICE", String(msg || "")]);
}

function ingestDerivedEvent(ev) {
  if (!ev || typeof ev !== "object") return;
  const kind = Number(ev.kind);
  if (kind === KINDS.adminClaim) {
    const p = parseObj(ev.content);
    if (!p) return;
    const pk = normPk(p.admin_pubkey || firstTag(ev, "admin"));
    if (!isHex64(pk) || pk !== normPk(ev.pubkey)) return;
    model.adminClaims.push({
      ev,
      pubkey: pk,
      claimed_at: unixOr(p.claimed_at || firstTag(ev, "version"), ev.created_at),
    });
    return;
  }
  if (kind === KINDS.adminRole) {
    const p = parseObj(ev.content);
    if (!p) return;
    const action = p.action === "grant" ? "grant" : p.action === "revoke" ? "revoke" : "";
    const target = normPk(p.target_pubkey || firstTag(ev, "p"));
    if (!action || !isHex64(target)) return;
    model.adminRoleEvents.push({
      ev,
      pubkey: normPk(ev.pubkey),
      target_pubkey: target,
      action,
      created_at: ev.created_at,
      id: ev.id,
    });
    return;
  }
  if (kind === KINDS.nameClaim) {
    const p = parseObj(ev.content);
    if (!p) return;
    const name = normName(p.name || firstTag(ev, "name"));
    if (!name) return;
    model.nameClaimEvents.push({
      ev,
      pubkey: normPk(ev.pubkey),
      name,
      created_at: ev.created_at,
      id: ev.id,
    });
    return;
  }
  if (kind === KINDS.snapshot) {
    const p = parseObj(ev.content);
    if (!p || !Array.isArray(p.entries)) return;
    model.snapshotEvents.push({
      ev,
      version_ts: unixOr(p.version_ts || firstTag(ev, "version"), ev.created_at),
      admin_pubkey: normPk(p.admin_pubkey || ""),
    });
  }
}

function recomputeDerived() {
  recomputeAdmin();
  recomputeNameClaims();
  recomputeSnapshotChoice();
}

function recomputeAdmin() {
  recomputeAdminRoot();
  recomputeAdminRoles();
}

function recomputeAdminRoot() {
  const sorted = [...model.adminClaims].sort((a, b) => {
    if (a.claimed_at !== b.claimed_at) return a.claimed_at - b.claimed_at;
    if (a.ev.created_at !== b.ev.created_at) return a.ev.created_at - b.ev.created_at;
    return String(a.ev.id || "").localeCompare(String(b.ev.id || ""));
  });
  if (sorted.length > 0) {
    model.admin = { pubkey: sorted[0].pubkey, claimEvent: sorted[0].ev };
  } else {
    model.admin = { pubkey: "", claimEvent: null };
  }
}

function recomputeAdminRoles() {
  const next = new Set();
  if (isHex64(model.admin.pubkey)) next.add(model.admin.pubkey);

  const sorted = [...model.adminRoleEvents].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  for (const role of sorted) {
    if (!next.has(role.pubkey)) continue;
    if (role.action === "grant") {
      next.add(role.target_pubkey);
    } else if (role.action === "revoke" && role.target_pubkey !== model.admin.pubkey) {
      next.delete(role.target_pubkey);
    }
  }
  model.admins = next;
}

function recomputeNameClaims() {
  const byName = new Map();
  const sorted = [...model.nameClaimEvents].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return String(a.id || "").localeCompare(String(b.id || ""));
  });
  for (const claim of sorted) {
    if (!byName.has(claim.name)) {
      byName.set(claim.name, {
        name: claim.name,
        pubkey: claim.pubkey,
        created_at: claim.created_at,
        id: claim.id,
      });
    }
  }

  const byPubInfo = new Map();
  for (const claim of sorted) {
    const owner = byName.get(claim.name);
    if (!owner || owner.pubkey !== claim.pubkey) continue;
    const cur = byPubInfo.get(claim.pubkey);
    if (!cur || claim.created_at > cur.created_at || (claim.created_at === cur.created_at && claim.id > cur.id)) {
      byPubInfo.set(claim.pubkey, {
        name: claim.name,
        created_at: claim.created_at,
        id: claim.id,
      });
    }
  }
  const byPub = new Map();
  for (const [pubkey, info] of byPubInfo.entries()) {
    byPub.set(pubkey, info.name);
  }
  model.nameOwnerByName = byName;
  model.nameByPubkey = byPub;
}

function recomputeSnapshotChoice() {
  let win = null;
  if (!isHex64(model.admin.pubkey)) {
    model.snapshot = null;
    return;
  }
  for (const s of model.snapshotEvents) {
    const signer = normPk(s.ev.pubkey);
    if (!model.admins.has(signer)) continue;
    if (s.admin_pubkey && s.admin_pubkey !== model.admin.pubkey) continue;
    if (!win) {
      win = s;
      continue;
    }
    if (s.version_ts > win.version_ts) {
      win = s;
      continue;
    }
    if (s.version_ts === win.version_ts) {
      if (s.ev.created_at > win.ev.created_at) {
        win = s;
        continue;
      }
      if (s.ev.created_at === win.ev.created_at && String(s.ev.id || "") > String(win.ev.id || "")) {
        win = s;
      }
    }
  }
  model.snapshot = win || null;
}

function maybeShareSnapshotForRequest(ev, originRelay) {
  if (!ev || Number(ev.kind) !== KINDS.snapshotRequest) return false;
  const p = parseObj(ev.content);
  if (!p) return false;
  const req = cleanRequestId(p.request_id || firstTag(ev, "req"));
  if (!req || model.snapshotRequestsSeen.has(req)) return false;
  model.snapshotRequestsSeen.add(req);
  if (!model.snapshot?.ev) return false;
  publishToUpstreams(model.snapshot.ev, String(originRelay || ""));
  broadcastEvent(model.snapshot.ev);
  return true;
}

function resolveUserExists(aliasInput) {
  const alias = normName(aliasInput);
  if (!alias) {
    return { alias: "", exists: false, owner_pubkey: "", owner_alias: "", claimed_at: 0, event_id: "" };
  }
  let owner = model.nameOwnerByName.get(alias) || null;
  let resolvedAlias = alias;
  if (!owner) {
    const lower = alias.toLowerCase();
    for (const [name, info] of model.nameOwnerByName.entries()) {
      if (name.toLowerCase() === lower) {
        owner = info;
        resolvedAlias = name;
        break;
      }
    }
  }
  if (!owner) {
    return { alias: resolvedAlias, exists: false, owner_pubkey: "", owner_alias: "", claimed_at: 0, event_id: "" };
  }
  return {
    alias: resolvedAlias,
    exists: true,
    owner_pubkey: owner.pubkey,
    owner_alias: model.nameByPubkey.get(owner.pubkey) || resolvedAlias,
    claimed_at: owner.created_at,
    event_id: owner.id,
  };
}

function resolveLatestSnapshot() {
  const snap = model.snapshot;
  if (!snap?.ev) {
    return { exists: false, event_id: "", version_ts: 0, admin_pubkey: "", created_at: 0, snapshot_event: null };
  }
  return {
    exists: true,
    event_id: String(snap.ev.id || ""),
    version_ts: unixOr(snap.version_ts, 0),
    admin_pubkey: normPk(snap.admin_pubkey || model.admin.pubkey || ""),
    created_at: unixOr(snap.ev.created_at, 0),
    snapshot_event: snap.ev,
  };
}

function resolveLogicalState() {
  return {
    root_admin: normPk(model.admin.pubkey || ""),
    admins: [...model.admins.values()],
    aliases: model.nameOwnerByName.size,
    snapshots: model.snapshotEvents.length,
    latest_snapshot_event_id: model.snapshot?.ev?.id || "",
    latest_snapshot_version_ts: model.snapshot?.version_ts || 0,
  };
}

function firstTag(ev, key) {
  const hit = ev?.tags?.find((t) => Array.isArray(t) && t[0] === key);
  return hit ? String(hit[1] || "") : "";
}

function parseObj(text) {
  if (typeof text !== "string") return null;
  try {
    const x = JSON.parse(text);
    return x && typeof x === "object" ? x : null;
  } catch {
    return null;
  }
}

function unixOr(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fb;
}

function normPk(v) {
  return String(v || "").trim().toLowerCase();
}

function normName(v) {
  return String(v || "").trim().replace(/^@+/, "").slice(0, 32);
}

function cleanRequestId(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "")
    .slice(0, 80);
}

function loadOrCreateRelayIdentity(identityFile, aliasOverride) {
  const file = String(identityFile || "").trim();
  if (!file) throw new Error("identity file path required");

  if (fs.existsSync(file)) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      const secret_key_hex = String(raw.secret_key_hex || "").toLowerCase();
      if (isHex64(secret_key_hex)) {
        const pubkey = derivePubkey(secret_key_hex);
        if (isHex64(pubkey)) {
          const alias = cleanAlias(String(aliasOverride || raw.alias || ""));
          return {
            alias: alias || aliasFromPubkey(pubkey),
            pubkey,
            secret_key_hex,
          };
        }
      }
    } catch {
      // Fall through to regenerate.
    }
  }

  const secret_key_hex = generateSecretKeyHex();
  const pubkey = derivePubkey(secret_key_hex);
  const alias = cleanAlias(String(aliasOverride || aliasFromPubkey(pubkey)));
  const out = {
    protocol: "nk3-relay-identity/v1",
    created_at: Math.floor(Date.now() / 1000),
    alias,
    pubkey,
    secret_key_hex,
  };
  fs.writeFileSync(file, JSON.stringify(out, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Non-posix filesystems may ignore mode.
  }
  return out;
}

function derivePubkey(secretKeyHex) {
  const sk = Buffer.from(secretKeyHex, "hex");
  const ecdh = crypto.createECDH("secp256k1");
  ecdh.setPrivateKey(sk);
  const uncompressed = ecdh.getPublicKey(null, "uncompressed");
  return Buffer.from(uncompressed).subarray(1, 33).toString("hex");
}

function generateSecretKeyHex() {
  const secpOrder = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
  while (true) {
    const bytes = crypto.randomBytes(32);
    const val = BigInt(`0x${bytes.toString("hex")}`);
    if (val > 0n && val < secpOrder) {
      return bytes.toString("hex");
    }
  }
}

function cleanAlias(v) {
  return String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function aliasFromPubkey(pubkey) {
  const a = [
    "amber", "atlas", "brisk", "cedar", "clear", "cobalt", "copper", "crisp",
    "delta", "ember", "fable", "fierce", "flint", "glint", "gold", "granite",
    "harbor", "hollow", "ion", "iron", "juniper", "kindle", "lattice", "lunar",
    "marble", "mesa", "mint", "moss", "nova", "onyx", "opal", "orbit",
    "pine", "plume", "pulse", "quartz", "rally", "ridge", "river", "rust",
    "sage", "scarlet", "signal", "silver", "slate", "solar", "sparrow", "spruce",
    "stone", "swift", "timber", "topaz", "trail", "union", "velvet", "vivid",
    "wave", "west", "whistle", "wild", "winter", "zenith", "zephyr", "zinc",
  ];
  const b = [
    "anchor", "arrow", "beacon", "blaze", "branch", "bridge", "brook", "canyon",
    "castle", "circle", "cloud", "comet", "crow", "dawn", "drift", "echo",
    "elm", "falcon", "field", "flare", "forest", "forge", "glacier", "grove",
    "harvest", "horizon", "isle", "junction", "lake", "lantern", "meadow", "meridian",
    "mountain", "north", "oak", "ocean", "path", "peak", "prairie", "ray",
    "reef", "resin", "road", "rook", "shore", "sierra", "sky", "spring",
    "star", "summit", "thunder", "tide", "torch", "tower", "valley", "vista",
    "voyage", "water", "willow", "wind", "wolf", "yard", "yonder", "zen",
  ];
  const c = [
    "alliance", "anthem", "arc", "banner", "beat", "bridge", "cadence", "call",
    "chorus", "collective", "current", "drum", "echo", "flame", "flow", "frame",
    "fuse", "gather", "groove", "harbor", "harmony", "hinge", "hymn", "line",
    "link", "march", "marker", "matrix", "movement", "north", "orbit", "origin",
    "pattern", "peak", "phase", "pulse", "rally", "record", "relay", "rhythm",
    "rise", "route", "signal", "spark", "spectrum", "spirit", "stone", "stream",
    "stride", "thread", "tide", "tone", "track", "union", "vector", "verse",
    "vibe", "voice", "wave", "waypoint", "wing", "witness", "yard", "zero",
  ];
  const hash = crypto.createHash("sha256").update(Buffer.from(pubkey, "hex")).digest();
  const p1 = a[hash[0] % a.length];
  const p2 = b[hash[13] % b.length];
  const p3 = c[hash[27] % c.length];
  return `${p1}-${p2}-${p3}`;
}

function isHex64(v) {
  return typeof v === "string" && /^[0-9a-f]{64}$/i.test(v);
}

function shortKey(pk) {
  const x = String(pk || "");
  if (x.length < 12) return x;
  return `${x.slice(0, 8)}..${x.slice(-6)}`;
}

function parseRelays(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || "").split(",")) {
    const x = String(part || "").trim();
    if (!x || seen.has(x)) continue;
    if (!(x.startsWith("wss://") || x.startsWith("ws://"))) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

function parseKinds(raw) {
  const out = [];
  const seen = new Set();
  for (const part of String(raw || "").split(",")) {
    const n = Number(String(part || "").trim());
    if (!Number.isFinite(n)) continue;
    const v = Math.floor(n);
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out.length > 0 ? out : [34123, 34124, 34125, 34126, 34127, 34128, 34129, 34130, 34131, 34132];
}
