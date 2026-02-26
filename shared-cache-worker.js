const DB_NAME = "nk3-shared-cache.v1";
const DB_VERSION = 1;
const STORE_EVENTS = "events";
const STORE_META = "meta";
const MAX_EVENTS = 15000;
const PRUNE_INTERVAL_WRITES = 200;

const ports = new Set();
let dbPromise = null;
let writesSincePrune = 0;
let pruning = false;

self.onconnect = (event) => {
  const port = event.ports?.[0];
  if (!port) return;
  ports.add(port);
  port.start();
  port.onmessage = (msgEvent) => {
    void handleMessage(port, msgEvent.data);
  };
  port.postMessage({ type: "ready" });
};

async function handleMessage(port, msg) {
  if (!msg || typeof msg !== "object") return;
  const type = String(msg.type || "");
  const requestId = String(msg.requestId || "");
  try {
    switch (type) {
      case "hello":
        return respond(port, requestId, true, { ok: true });
      case "put_event": {
        if (isEventLike(msg.event)) {
          await putEvent(msg.event);
        }
        return respond(port, requestId, true, { ok: true });
      }
      case "put_events": {
        const list = Array.isArray(msg.events) ? msg.events : [];
        for (const ev of list) {
          if (!isEventLike(ev)) continue;
          await putEvent(ev);
        }
        return respond(port, requestId, true, { ok: true });
      }
      case "get_events": {
        const limit = Number.isFinite(Number(msg.limit)) ? Math.max(1, Math.min(20000, Number(msg.limit))) : 5000;
        const events = await getEvents(limit);
        return respond(port, requestId, true, events);
      }
      case "set_meta": {
        const key = String(msg.key || "").trim();
        if (key) {
          await setMeta(key, msg.value ?? null);
        }
        return respond(port, requestId, true, { ok: true });
      }
      case "get_meta": {
        const key = String(msg.key || "").trim();
        const value = key ? await getMeta(key) : null;
        return respond(port, requestId, true, value);
      }
      default:
        return respond(port, requestId, false, null, `unsupported message type ${type}`);
    }
  } catch (err) {
    respond(port, requestId, false, null, err?.message || String(err));
  }
}

function respond(port, requestId, ok, data, error) {
  if (!requestId) return;
  port.postMessage({
    type: "response",
    requestId,
    ok: Boolean(ok),
    data: data ?? null,
    error: error ? String(error) : "",
  });
}

function isEventLike(ev) {
  return Boolean(
    ev
      && typeof ev === "object"
      && typeof ev.id === "string"
      && typeof ev.pubkey === "string"
      && Number.isFinite(Number(ev.kind))
      && Number.isFinite(Number(ev.created_at))
      && Array.isArray(ev.tags)
      && typeof ev.content === "string"
      && typeof ev.sig === "string",
  );
}

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_EVENTS)) {
        const events = db.createObjectStore(STORE_EVENTS, { keyPath: "id" });
        events.createIndex("created_at", "created_at", { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error("indexedDB open failed"));
  }).catch((err) => {
    dbPromise = null;
    throw err;
  });
  return dbPromise;
}

function txDone(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error("transaction failed"));
    tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
  });
}

async function putEvent(ev) {
  const db = await openDb();
  const tx = db.transaction(STORE_EVENTS, "readwrite");
  tx.objectStore(STORE_EVENTS).put(ev);
  await txDone(tx);
  writesSincePrune += 1;
  if (writesSincePrune >= PRUNE_INTERVAL_WRITES) {
    writesSincePrune = 0;
    void maybePruneEvents();
  }
}

async function getEvents(limit) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_EVENTS, "readonly");
    const store = tx.objectStore(STORE_EVENTS);
    const index = store.index("created_at");
    const out = [];
    const cursorReq = index.openCursor(null, "prev");
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor || out.length >= limit) {
        resolve(out);
        return;
      }
      out.push(cursor.value);
      cursor.continue();
    };
    cursorReq.onerror = () => reject(cursorReq.error || new Error("cursor failed"));
    tx.onerror = () => reject(tx.error || new Error("transaction failed"));
  });
}

async function setMeta(key, value) {
  const db = await openDb();
  const tx = db.transaction(STORE_META, "readwrite");
  tx.objectStore(STORE_META).put({ key, value });
  await txDone(tx);
}

async function getMeta(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_META, "readonly");
    const req = tx.objectStore(STORE_META).get(key);
    req.onsuccess = () => resolve(req.result?.value ?? null);
    req.onerror = () => reject(req.error || new Error("meta get failed"));
    tx.onerror = () => reject(tx.error || new Error("transaction failed"));
  });
}

async function maybePruneEvents() {
  if (pruning) return;
  pruning = true;
  try {
    const db = await openDb();
    const tx = db.transaction(STORE_EVENTS, "readwrite");
    const store = tx.objectStore(STORE_EVENTS);
    const countReq = store.count();
    countReq.onsuccess = () => {
      const total = Number(countReq.result || 0);
      const toDelete = total - MAX_EVENTS;
      if (toDelete <= 0) return;
      const index = store.index("created_at");
      let removed = 0;
      const cursorReq = index.openCursor(null, "next");
      cursorReq.onsuccess = () => {
        const cursor = cursorReq.result;
        if (!cursor || removed >= toDelete) return;
        store.delete(cursor.primaryKey);
        removed += 1;
        cursor.continue();
      };
    };
    await txDone(tx);
  } catch {
    // Ignore prune failures; cache still functions without trim.
  } finally {
    pruning = false;
  }
}
