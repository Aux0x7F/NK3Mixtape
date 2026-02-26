const eventTools = window.EventTools || window[["No", "strTools"].join("")];
if (!eventTools) throw new Error("event tools unavailable");
const { SimplePool, finalizeEvent, getPublicKey, verifyEvent } = eventTools;

const APP = {
  tag: "no-kings-playlist",
  kinds: {
    entry: 34123,
    vote: 34124,
    mod: 34125,
    snapshot: 34126,
    adminClaim: 34127,
    adminRole: 34128,
    userMod: 34129,
    nameClaim: 34130,
    profile: 34131,
    snapshotRequest: 34132,
  },
  relays: ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nos.lol"],
  bootstrapAdminPubkey: "",
  pasteUrl: "https://dpaste.com/api/v2/",
  // Optional fallback paste URLs (newest first) for totally fresh clients.
  bootstrapBackupUrls: [],
};

const DEFAULT_SNAPSHOT = [
  { entry_id: "seed:no-kings:1", title: "Killing in the Name", artist: "Rage Against the Machine", user: "seed", created_at: 1710000000 },
  { entry_id: "seed:no-kings:2", title: "Fight the Power", artist: "Public Enemy", user: "seed", created_at: 1710000100 },
  { entry_id: "seed:no-kings:3", title: "Alright", artist: "Kendrick Lamar", user: "seed", created_at: 1710000200 },
];

const STORAGE_SESSION = "nk3.session.v2";
const STORAGE_IDENTITY_LEGACY = "nk3.identity.v1";
const STORAGE_LAST_NAME = "nk3.name.v1";
const STORAGE_BACKUPS = "nk3.backups.v1";
const STORAGE_RECOVERY = "nk3.recovery.v1";
const RECOVERY_PROTOCOL = "nk3-recovery/v1";
const SHARED_CACHE_META_RECOVERY = "recovery_doc";
const SHARED_CACHE_META_BACKUPS = "backups";
const SHARED_CACHE_LOAD_LIMIT = 8000;
const SHARED_CACHE_TIMEOUT_MS = 8000;

const pool = new SimplePool();

const state = {
  identity: null,
  lastName: "",
  install: {
    promptEvent: null,
    installed: false,
  },
  sharedCache: {
    port: null,
    connected: false,
    requestSeq: 0,
    pending: new Map(),
    hydrating: false,
  },
  seen: new Set(),
  synced: false,
  showRevoked: false,
  usernames: new Map(),
  entries: new Map(),
  votes: new Map(),
  admin: { pubkey: normPk(APP.bootstrapAdminPubkey), claimEvent: null },
  admins: new Set(),
  adminClaims: [],
  adminRoleEvents: [],
  modEvents: [],
  mods: new Map(),
  userModEvents: [],
  userBans: new Map(),
  nameClaimEvents: [],
  nameOwnerByName: new Map(),
  nameByPubkey: new Map(),
  profileEvents: [],
  profilesByPubkey: new Map(),
  snapshotEvents: [],
  snapshot: null,
  snapshotRequestsSeen: new Set(),
  backups: [],
  youtube: {
    apiPromise: null,
    playerPromise: null,
    player: null,
    currentEntryId: "",
    currentVideoId: "",
    isPlaying: false,
  },
  userModalContext: null,
  deleteConfirmContext: null,
};

let renderQueued = false;

const el = {
  appMain: document.getElementById("appMain"),
  authSplash: document.getElementById("authSplash"),
  signinForm: document.getElementById("signinForm"),
  nameInput: document.getElementById("nameInput"),
  passphraseInput: document.getElementById("passphraseInput"),
  splashInstallBtn: document.getElementById("splashInstallBtn"),
  splashStatus: document.getElementById("splashStatus"),
  identityContainer: document.getElementById("identityContainer"),
  tplIn: document.getElementById("identityTemplateLoggedIn"),
  backupMeta: document.getElementById("backupMetaLine"),
  wizard: document.getElementById("wizardTools"),
  wizardText: document.getElementById("wizardText"),
  claimAdminBtn: document.getElementById("claimAdminBtn"),
  downloadKeysBtn: document.getElementById("downloadKeysBtn"),
  openAddSongBtn: document.getElementById("openAddSongBtn"),
  cancelAddSongBtn: document.getElementById("cancelAddSongBtn"),
  addSongModal: document.getElementById("addSongModal"),
  publishSnapshotBtn: document.getElementById("publishSnapshotBtn"),
  showRevokedToggle: document.getElementById("showRevokedToggle"),
  adminPubkeyInput: document.getElementById("adminPubkeyInput"),
  grantAdminBtn: document.getElementById("grantAdminBtn"),
  revokeAdminBtn: document.getElementById("revokeAdminBtn"),
  menuModal: document.getElementById("menuModal"),
  menuIdentity: document.getElementById("menuIdentity"),
  adminModal: document.getElementById("adminModal"),
  openProfileBtn: document.getElementById("openProfileBtn"),
  openAdminBtn: document.getElementById("openAdminBtn"),
  menuInstallBtn: document.getElementById("menuInstallBtn"),
  menuLogoutBtn: document.getElementById("menuLogoutBtn"),
  profileModal: document.getElementById("profileModal"),
  profileForm: document.getElementById("profileForm"),
  profileNameInput: document.getElementById("profileNameInput"),
  profileSocialInput: document.getElementById("profileSocialInput"),
  profileBioInput: document.getElementById("profileBioInput"),
  userModal: document.getElementById("userModal"),
  userModalName: document.getElementById("userModalName"),
  userModalSocial: document.getElementById("userModalSocial"),
  userModalBio: document.getElementById("userModalBio"),
  userModalEntryMeta: document.getElementById("userModalEntryMeta"),
  userModalAdminBlock: document.getElementById("userModalAdminBlock"),
  userModalBanState: document.getElementById("userModalBanState"),
  userModalBanBtn: document.getElementById("userModalBanBtn"),
  userModalTempBanMinutesInput: document.getElementById("userModalTempBanMinutesInput"),
  userModalTempBanBtn: document.getElementById("userModalTempBanBtn"),
  userModalUnbanBtn: document.getElementById("userModalUnbanBtn"),
  deleteConfirmModal: document.getElementById("deleteConfirmModal"),
  deleteConfirmText: document.getElementById("deleteConfirmText"),
  confirmDeleteBtn: document.getElementById("confirmDeleteBtn"),
  cancelDeleteBtn: document.getElementById("cancelDeleteBtn"),
  recoveryUrl: document.getElementById("backupUrlInput"),
  restoreBackupBtn: document.getElementById("restoreBackupBtn"),
  backupFileInput: document.getElementById("backupFileInput"),
  entryForm: document.getElementById("entryForm"),
  titleInput: document.getElementById("titleInput"),
  artistInput: document.getElementById("artistInput"),
  youtubeInput: document.getElementById("youtubeInput"),
  ytPlayerHost: document.getElementById("ytPlayerHost"),
  list: document.getElementById("list"),
};

void init();

function init() {
  registerServiceWorker();
  bind();
  initInstallPrompt();
  hydrateIdentity();
  hydrateBackups();
  hydrateRecovery();
  initSharedCache();
  recomputeAdmin();
  recomputeNameClaims();
  setInterval(() => {
    if (recomputeUserBans()) {
      renderIdentity();
      renderList();
    }
  }, 30000);
  installConsoleInterface();
  renderIdentity();
  renderWizard();
  renderBackupMeta();
  renderList();
  void hydrateFromSharedCache();
  void tryRestoreBootstrap();
  connect();
}

function bind() {
  if (el.signinForm) {
    el.signinForm.addEventListener("submit", onSigninSubmit);
  }
  if (el.openAddSongBtn) {
    el.openAddSongBtn.addEventListener("click", () => {
      if (!state.identity) return;
      openModal(el.addSongModal);
      el.titleInput?.focus();
    });
  }
  if (el.cancelAddSongBtn) {
    el.cancelAddSongBtn.addEventListener("click", () => {
      closeModal(el.addSongModal);
    });
  }
  if (el.splashInstallBtn) {
    el.splashInstallBtn.addEventListener("click", () => void onInstallClick());
  }
  if (el.menuInstallBtn) {
    el.menuInstallBtn.addEventListener("click", () => void onInstallClick());
  }
  el.entryForm.addEventListener("submit", onEntrySubmit);
  if (el.publishSnapshotBtn) {
    el.publishSnapshotBtn.addEventListener("click", onPublishSnapshot);
  }
  el.showRevokedToggle.addEventListener("change", () => {
    state.showRevoked = el.showRevokedToggle.checked;
    renderList();
  });
  if (el.grantAdminBtn) {
    el.grantAdminBtn.addEventListener("click", () => void onAdminRoleChange("grant"));
  }
  if (el.revokeAdminBtn) {
    el.revokeAdminBtn.addEventListener("click", () => void onAdminRoleChange("revoke"));
  }
  el.claimAdminBtn.addEventListener("click", onClaimAdmin);
  el.downloadKeysBtn.addEventListener("click", onDownloadKeys);
  el.restoreBackupBtn.addEventListener("click", () => void onRestoreBackup());
  el.backupFileInput.addEventListener("change", () => void onImportFile());
  if (el.openProfileBtn) {
    el.openProfileBtn.addEventListener("click", () => {
      closeModal(el.menuModal);
      openProfileModal();
    });
  }
  if (el.openAdminBtn) {
    el.openAdminBtn.addEventListener("click", () => {
      closeModal(el.menuModal);
      openModal(el.adminModal);
    });
  }
  if (el.menuLogoutBtn) {
    el.menuLogoutBtn.addEventListener("click", () => {
      closeModal(el.menuModal);
      onLogout();
    });
  }
  if (el.profileForm) {
    el.profileForm.addEventListener("submit", (event) => {
      void onProfileSave(event);
    });
  }
  if (el.userModalBanBtn) {
    el.userModalBanBtn.addEventListener("click", () => void onUserModalBanChange("ban"));
  }
  if (el.userModalTempBanBtn) {
    el.userModalTempBanBtn.addEventListener("click", () => void onUserModalBanChange("temp_ban"));
  }
  if (el.userModalUnbanBtn) {
    el.userModalUnbanBtn.addEventListener("click", () => void onUserModalBanChange("unban"));
  }
  if (el.confirmDeleteBtn) {
    el.confirmDeleteBtn.addEventListener("click", () => void onConfirmDelete());
  }
  if (el.cancelDeleteBtn) {
    el.cancelDeleteBtn.addEventListener("click", () => {
      closeModal(el.deleteConfirmModal);
    });
  }

  document.querySelectorAll("[data-close-modal]").forEach((node) => {
    node.addEventListener("click", () => {
      const id = node.getAttribute("data-close-modal");
      closeModal(document.getElementById(id));
    });
  });
  [el.menuModal, el.adminModal, el.profileModal, el.userModal, el.addSongModal, el.deleteConfirmModal].forEach((modal) => {
    if (!modal) return;
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });
  });
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("./sw.js").catch((err) => {
    console.error(err);
  });
}

function initInstallPrompt() {
  const standalone = window.matchMedia?.("(display-mode: standalone)")?.matches || Boolean(window.navigator.standalone);
  state.install.installed = standalone;
  renderInstallControls();
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    state.install.promptEvent = event;
    renderInstallControls();
  });
  window.addEventListener("appinstalled", () => {
    state.install.installed = true;
    state.install.promptEvent = null;
    renderInstallControls();
    setStatus("app installed");
  });
}

function renderInstallControls() {
  const show = Boolean(!state.install.installed && state.install.promptEvent);
  if (el.splashInstallBtn) el.splashInstallBtn.classList.toggle("hidden", !show);
  if (el.menuInstallBtn) el.menuInstallBtn.classList.toggle("hidden", !show);
}

async function onInstallClick() {
  const promptEvent = state.install.promptEvent;
  if (!promptEvent) {
    return setStatus("install unavailable on this browser/session");
  }
  state.install.promptEvent = null;
  renderInstallControls();
  try {
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    if (choice?.outcome === "accepted") {
      setStatus("install accepted");
    } else {
      setStatus("install dismissed");
    }
  } catch (err) {
    console.error(err);
    setStatus("install failed");
  }
}

function initSharedCache() {
  if (typeof SharedWorker !== "function") return;
  try {
    const worker = new SharedWorker("./shared-cache-worker.js", { name: "nk3-shared-cache" });
    const port = worker.port;
    state.sharedCache.port = port;
    port.addEventListener("message", onSharedCacheMessage);
    port.start();
    port.postMessage({ type: "hello" });
  } catch (err) {
    console.error(err);
  }
}

function onSharedCacheMessage(event) {
  const msg = event?.data;
  if (!msg || typeof msg !== "object") return;
  if (msg.type === "ready") {
    state.sharedCache.connected = true;
    return;
  }
  if (msg.type !== "response") return;

  const requestId = String(msg.requestId || "");
  if (!requestId) return;
  const pending = state.sharedCache.pending.get(requestId);
  if (!pending) return;

  clearTimeout(pending.timer);
  state.sharedCache.pending.delete(requestId);
  if (msg.ok) {
    pending.resolve(msg.data);
  } else {
    pending.reject(new Error(String(msg.error || "shared cache request failed")));
  }
}

function sharedCacheRequest(type, payload = {}, timeoutMs = SHARED_CACHE_TIMEOUT_MS) {
  const port = state.sharedCache.port;
  if (!port) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const requestId = `r${Date.now().toString(36)}-${(state.sharedCache.requestSeq += 1).toString(36)}`;
    const timer = setTimeout(() => {
      state.sharedCache.pending.delete(requestId);
      reject(new Error(`shared cache timeout for ${type}`));
    }, timeoutMs);
    state.sharedCache.pending.set(requestId, { resolve, reject, timer });
    port.postMessage({ type, requestId, ...payload });
  });
}

function sharedCachePersistEvent(ev) {
  if (!ev?.id || !state.sharedCache.port || state.sharedCache.hydrating) return;
  state.sharedCache.port.postMessage({ type: "put_event", event: ev });
}

function sharedCachePersistMeta(key, value) {
  if (!key || !state.sharedCache.port) return;
  state.sharedCache.port.postMessage({ type: "set_meta", key, value });
}

async function hydrateFromSharedCache() {
  if (!state.sharedCache.port) return;
  state.sharedCache.hydrating = true;
  try {
    const [events, cachedRecovery, cachedBackups] = await Promise.all([
      sharedCacheRequest("get_events", { limit: SHARED_CACHE_LOAD_LIMIT }).catch(() => []),
      sharedCacheRequest("get_meta", { key: SHARED_CACHE_META_RECOVERY }).catch(() => null),
      sharedCacheRequest("get_meta", { key: SHARED_CACHE_META_BACKUPS }).catch(() => null),
    ]);

    let changed = false;
    if (Array.isArray(events)) {
      for (const ev of events) {
        changed = ingestEvent(ev, { persist: false }) || changed;
      }
    }
    if (cachedRecovery && typeof cachedRecovery === "object") {
      changed = importRecoveryDoc(cachedRecovery, { source: "shared cache", silent: true, cache: false }) || changed;
    }
    if (state.backups.length === 0 && Array.isArray(cachedBackups)) {
      const normalized = normalizeBackups(cachedBackups);
      if (normalized.length > 0) {
        state.backups = normalized;
        renderBackupMeta();
      }
    }
    if (changed) {
      renderIdentity();
      renderWizard();
      renderList();
    }
  } catch (err) {
    console.error(err);
  } finally {
    state.sharedCache.hydrating = false;
  }
}

function normalizeBackups(arr) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({ url: normBackupUrl(x.url || ""), version_ts: unixOr(x.version_ts, 0), touched_at: unixOr(x.touched_at, nowSec()) }))
    .filter((x) => x.url)
    .sort((a, b) => (b.version_ts !== a.version_ts ? b.version_ts - a.version_ts : b.touched_at - a.touched_at))
    .slice(0, 24);
}

function hydrateIdentity() {
  state.lastName = normName(localStorage.getItem(STORAGE_LAST_NAME) || "");
  const sessionRaw = localStorage.getItem(STORAGE_SESSION);
  if (sessionRaw) {
    try {
      const x = JSON.parse(sessionRaw);
      const name = normName(x.name || "");
      const pubkey = normPk(x.pubkey || "");
      const sk = String(x.secretKeyHex || "").toLowerCase();
      if (name && isHex64(pubkey) && isHex64(sk) && getPublicKey(hexToBytes(sk)) === pubkey) {
        state.identity = { name, pubkey, secretKeyHex: sk };
        if (!state.lastName) {
          state.lastName = name;
          localStorage.setItem(STORAGE_LAST_NAME, name);
        }
        rememberName(pubkey, name, nowSec());
        return;
      }
    } catch (e) {
      console.error(e);
    }
    localStorage.removeItem(STORAGE_SESSION);
  }

  const raw = localStorage.getItem(STORAGE_IDENTITY_LEGACY);
  if (!raw) return;
  try {
    const x = JSON.parse(raw);
    const name = normName(x.name || "");
    const pubkey = normPk(x.pubkey || "");
    const sk = String(x.secretKeyHex || "").toLowerCase();
    if (name && isHex64(pubkey) && isHex64(sk) && getPublicKey(hexToBytes(sk)) === pubkey) {
      state.identity = { name, pubkey, secretKeyHex: sk };
      persistSession();
      rememberName(pubkey, name, nowSec());
    }
    if (name) {
      state.lastName = name;
      localStorage.setItem(STORAGE_LAST_NAME, name);
    }
  } catch (e) {
    console.error(e);
  }
  localStorage.removeItem(STORAGE_IDENTITY_LEGACY);
}

function hydrateBackups() {
  const raw = localStorage.getItem(STORAGE_BACKUPS);
  if (!raw) return;
  try {
    state.backups = normalizeBackups(JSON.parse(raw));
  } catch (e) {
    console.error(e);
  }
}

function hydrateRecovery() {
  const raw = localStorage.getItem(STORAGE_RECOVERY);
  if (!raw) return;
  try {
    const doc = JSON.parse(raw);
    importRecoveryDoc(doc, { source: "local cache", silent: true, cache: false });
  } catch (e) {
    console.error(e);
  }
}

function renderAccess() {
  const signedIn = Boolean(state.identity);
  el.authSplash.classList.toggle("hidden", signedIn);
  el.appMain.classList.toggle("hidden", !signedIn);
  if (!signedIn) {
    if (el.openAddSongBtn) el.openAddSongBtn.classList.add("hidden");
    if (state.lastName && el.nameInput) el.nameInput.value = state.lastName;
    if (el.passphraseInput) el.passphraseInput.value = "";
    closeModal(el.menuModal);
    closeModal(el.adminModal);
    closeModal(el.profileModal);
    closeModal(el.userModal);
    closeModal(el.addSongModal);
    closeModal(el.deleteConfirmModal);
    state.userModalContext = null;
    state.deleteConfirmContext = null;
    if (el.menuIdentity) el.menuIdentity.textContent = "";
    el.identityContainer.replaceChildren();
  }
}

function renderIdentity() {
  renderAccess();
  if (!state.identity) return;

  el.identityContainer.replaceChildren();
  const frag = el.tplIn.content.cloneNode(true);
  const menuBtn = frag.querySelector("#menuBtn");
  const ban = activeBanForPubkey(state.identity.pubkey);
  menuBtn?.addEventListener("click", () => openModal(el.menuModal));
  el.identityContainer.appendChild(frag);
  if (el.menuIdentity) {
    const flags = [];
    if (isAdminMe()) flags.push("admin");
    if (ban) flags.push(ban.until_ts ? `banned until ${fmtDate(ban.until_ts)}` : "banned");
    el.menuIdentity.textContent = `@${state.identity.name} ${shortPk(state.identity.pubkey)}${flags.length ? ` · ${flags.join(" · ")}` : ""}`;
  }

  if (el.openAddSongBtn) {
    el.openAddSongBtn.classList.remove("hidden");
    el.openAddSongBtn.disabled = Boolean(activeBanForPubkey(state.identity.pubkey));
  }
  if (el.openAdminBtn) {
    const canOpenAdmin = isAdminMe() || !hasAdmin();
    el.openAdminBtn.classList.toggle("hidden", !canOpenAdmin);
  }
  const locked = Boolean(activeBanForPubkey(state.identity.pubkey));
  for (const control of el.entryForm.querySelectorAll("input,button")) {
    control.disabled = locked;
  }
  if (!isAdminMe()) {
    state.showRevoked = false;
    el.showRevokedToggle.checked = false;
    closeModal(el.adminModal);
  }
}

function renderWizard() {
  const show = Boolean(state.identity);
  el.wizard.classList.toggle("hidden", !show);
  if (!show) return;
  if (!hasAdmin()) {
    el.wizardText.textContent = "no admin yet";
    el.claimAdminBtn.classList.remove("hidden");
  } else {
    const adminCount = state.admins.size || 1;
    const label = adminCount > 1 ? `admins ${adminCount}` : "admin";
    el.wizardText.textContent = `${label} ${shortPk(state.admin.pubkey)}`;
    el.claimAdminBtn.classList.add("hidden");
  }
}

function renderBackupMeta() {
  if (!el.backupMeta) return;
  el.backupMeta.replaceChildren();
  if (state.backups.length === 0) return;
  const x = state.backups[0];
  const pre = document.createElement("span");
  pre.textContent = "backup ";
  const a = document.createElement("a");
  a.href = x.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.textContent = `v${x.version_ts || "?"}`;
  el.backupMeta.append(pre, a);
}

async function onSigninSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const name = normName(form.querySelector("#nameInput")?.value || "");
  const pass = String(form.querySelector("#passphraseInput")?.value || "").trim();
  if (!name) return setStatus("alias required");
  if (!pass) {
    el.passphraseInput?.focus();
    return setStatus("password required");
  }
  localStorage.setItem(STORAGE_LAST_NAME, name);
  state.lastName = name;
  setStatus("deriving key...");
  let skBytes = await deriveSecretKey(pass);
  let pubkey = getPublicKey(skBytes);
  const nameOwner = ownerPubkeyForName(name);
  if (nameOwner && nameOwner !== pubkey) {
    const legacySk = await deriveLegacySecretKey(pass, name);
    const legacyPubkey = getPublicKey(legacySk);
    if (legacyPubkey === nameOwner) {
      skBytes = legacySk;
      pubkey = legacyPubkey;
    } else {
      el.passphraseInput?.focus();
      return setStatus(`wrong password for @${name}`);
    }
  }
  state.identity = { name, pubkey, secretKeyHex: bytesToHex(skBytes) };
  rememberName(pubkey, name, nowSec());
  persistSession();
  void ensureNameClaimForCurrentUser(name);
  renderIdentity();
  renderWizard();
  renderList();
  setStatus(`signed in @${name}`);
}

function onLogout() {
  state.identity = null;
  localStorage.removeItem(STORAGE_SESSION);
  renderIdentity();
  renderWizard();
  renderList();
  setStatus("signed out");
}
function persistSession() {
  if (!state.identity) return;
  localStorage.setItem(STORAGE_SESSION, JSON.stringify({
    name: state.identity.name,
    pubkey: state.identity.pubkey,
    secretKeyHex: state.identity.secretKeyHex,
  }));
}

function connect() {
  const filter = {
    kinds: [
      APP.kinds.adminClaim,
      APP.kinds.adminRole,
      APP.kinds.userMod,
      APP.kinds.nameClaim,
      APP.kinds.profile,
      APP.kinds.entry,
      APP.kinds.vote,
      APP.kinds.mod,
      APP.kinds.snapshot,
      APP.kinds.snapshotRequest,
    ],
    "#t": [APP.tag],
    limit: 5000,
  };
  setStatus(`syncing ${APP.relays.length} relays...`);
  pool.subscribeMany(APP.relays, filter, {
    onevent: (ev) => {
      if (ingestEvent(ev)) queueRender();
    },
    oneose: () => {
      state.synced = true;
      setStatus(`synced ${state.seen.size} events${hasAdmin() ? ` admin ${shortPk(state.admin.pubkey)}` : " no admin"}`);
      renderIdentity();
      renderWizard();
      renderList();
    },
    onclose: (reasons) => {
      const closed = reasons.filter(Boolean).length;
      if (closed > 0 && !state.synced) setStatus(`relay close ${closed}/${APP.relays.length}`);
    },
  });
}

function ingestEvent(ev, { persist = true } = {}) {
  if (!ev || typeof ev !== "object") return false;
  if (state.seen.has(ev.id)) return false;
  try {
    if (!verifyEvent(ev)) return false;
  } catch {
    return false;
  }
  if (!hasTag(ev, "t", APP.tag)) return false;
  state.seen.add(ev.id);
  if (persist) sharedCachePersistEvent(ev);
  switch (ev.kind) {
    case APP.kinds.adminClaim:
      return applyAdminClaim(ev);
    case APP.kinds.adminRole:
      return applyAdminRole(ev);
    case APP.kinds.userMod:
      return applyUserMod(ev);
    case APP.kinds.nameClaim:
      return applyNameClaim(ev);
    case APP.kinds.profile:
      return applyProfile(ev);
    case APP.kinds.entry:
      return applyEntry(ev);
    case APP.kinds.vote:
      return applyVote(ev);
    case APP.kinds.mod:
      return applyMod(ev);
    case APP.kinds.snapshot:
      return applySnapshot(ev);
    case APP.kinds.snapshotRequest:
      return applySnapshotRequest(ev);
    default:
      return false;
  }
}

function applyAdminClaim(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;
  const pk = normPk(p.admin_pubkey || firstTag(ev, "admin"));
  if (!isHex64(pk) || ev.pubkey !== pk) return false;
  state.adminClaims.push({ ev, pubkey: pk, claimed_at: unixOr(p.claimed_at || firstTag(ev, "version"), ev.created_at) });
  return recomputeAdmin();
}

function applyAdminRole(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;

  const action = p.action === "grant" ? "grant" : p.action === "revoke" ? "revoke" : "";
  const target = normPk(p.target_pubkey || firstTag(ev, "p"));
  if (!action || !isHex64(target)) return false;

  state.adminRoleEvents.push({
    ev,
    pubkey: normPk(ev.pubkey),
    target_pubkey: target,
    action,
    created_at: ev.created_at,
    id: ev.id,
  });
  return recomputeAdmin();
}

function applyUserMod(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;

  const action =
    p.action === "ban"
      ? "ban"
      : p.action === "temp_ban"
        ? "temp_ban"
        : p.action === "unban"
          ? "unban"
          : "";
  const target = normPk(p.target_pubkey || firstTag(ev, "p"));
  const until_ts = unixOr(p.until_ts || firstTag(ev, "until"), 0);
  if (!action || !isHex64(target)) return false;

  state.userModEvents.push({
    ev,
    pubkey: normPk(ev.pubkey),
    target_pubkey: target,
    action,
    until_ts,
    created_at: ev.created_at,
    id: ev.id,
  });
  return recomputeUserBans();
}

function applyNameClaim(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;
  const name = normName(p.name || firstTag(ev, "name"));
  if (!name) return false;
  state.nameClaimEvents.push({
    ev,
    pubkey: normPk(ev.pubkey),
    name,
    created_at: ev.created_at,
    id: ev.id,
  });
  return recomputeNameClaims();
}

function applyProfile(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;

  const pubkey = normPk(ev.pubkey);
  const name = normName(p.name || "");
  const social = cleanSocial(p.social || "");
  const bio = cleanBio(p.bio || "");
  const current = state.profilesByPubkey.get(pubkey);
  if (current && (current.created_at > ev.created_at || (current.created_at === ev.created_at && current.id >= ev.id))) {
    return false;
  }

  state.profileEvents.push({
    ev,
    pubkey,
    name,
    social,
    bio,
    created_at: ev.created_at,
    id: ev.id,
  });
  state.profilesByPubkey.set(pubkey, {
    pubkey,
    name,
    social,
    bio,
    created_at: ev.created_at,
    id: ev.id,
  });
  return true;
}

function recomputeAdmin() {
  const adminRootChanged = recomputeAdminRoot();
  const adminRolesChanged = recomputeAdminRoles();
  const governedChanged = recomputeMods() || recomputeSnapshotChoice() || recomputeUserBans();
  const adminChanged = adminRootChanged || adminRolesChanged;
  if (adminChanged) {
    renderIdentity();
    renderWizard();
  }
  return adminChanged || governedChanged;
}

function recomputeAdminRoot() {
  const prev = state.admin.pubkey;
  const prevClaim = state.admin.claimEvent?.id || "";

  if (isHex64(APP.bootstrapAdminPubkey)) {
    state.admin = { pubkey: normPk(APP.bootstrapAdminPubkey), claimEvent: null };
  } else {
    const sorted = [...state.adminClaims].sort((a, b) => {
      if (a.claimed_at !== b.claimed_at) return a.claimed_at - b.claimed_at;
      if (a.ev.created_at !== b.ev.created_at) return a.ev.created_at - b.ev.created_at;
      return a.ev.id.localeCompare(b.ev.id);
    });
    if (sorted.length > 0) {
      state.admin = { pubkey: sorted[0].pubkey, claimEvent: sorted[0].ev };
    } else {
      state.admin = { pubkey: "", claimEvent: null };
    }
  }

  return prev !== state.admin.pubkey || prevClaim !== (state.admin.claimEvent?.id || "");
}

function recomputeAdminRoles() {
  const previous = new Set(state.admins);
  const next = new Set();

  if (isHex64(state.admin.pubkey)) {
    next.add(state.admin.pubkey);
  }

  const sortedRoles = [...state.adminRoleEvents].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at - b.created_at;
    return a.id.localeCompare(b.id);
  });

  for (const role of sortedRoles) {
    if (!next.has(role.pubkey)) continue;
    if (role.action === "grant") {
      next.add(role.target_pubkey);
    } else if (role.action === "revoke") {
      if (role.target_pubkey !== state.admin.pubkey) {
        next.delete(role.target_pubkey);
      }
    }
  }

  state.admins = next;
  return !setSame(previous, next);
}

function applyEntry(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;
  const entry_id = cleanEntryId(p.entry_id || firstTag(ev, "d"));
  const title = cleanText(p.title, 120);
  const artist = cleanText(p.artist, 120);
  const youtube_id = youtubeIdFromAny(p.youtube_id || p.youtube_url || firstTag(ev, "yt"));
  const youtube_url = youtube_id ? canonicalYouTubeUrl(youtube_id) : "";
  const user = normName(p.user || "");
  const created_at = unixOr(p.created_at, ev.created_at);
  if (!entry_id || !title || !artist) return false;
  if (user) rememberName(ev.pubkey, user, ev.created_at);
  const cur = state.entries.get(entry_id);
  if (cur && cur.event_created_at > ev.created_at) return false;
  state.entries.set(entry_id, {
    entry_id,
    title,
    artist,
    youtube_id,
    youtube_url,
    user: user || resolveName(ev.pubkey),
    created_at,
    pubkey: ev.pubkey,
    event_created_at: ev.created_at,
  });
  return true;
}

function applyVote(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;
  const entry_id = cleanEntryId(p.entry_id || firstTag(ev, "d"));
  if (!entry_id) return false;
  const value = clampVote(p.value);
  const user = normName(p.user || "");
  if (user) rememberName(ev.pubkey, user, ev.created_at);
  const byEntry = state.votes.get(entry_id) || new Map();
  const cur = byEntry.get(ev.pubkey);
  if (cur && cur.event_created_at > ev.created_at) return false;
  byEntry.set(ev.pubkey, { value, user, event_created_at: ev.created_at });
  state.votes.set(entry_id, byEntry);
  return true;
}

function applyMod(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;
  const entry_id = cleanEntryId(p.entry_id || firstTag(ev, "d"));
  const action = p.action === "restore" ? "restore" : p.action === "revoke" ? "revoke" : "";
  if (!entry_id || !action) return false;
  state.modEvents.push({ entry_id, action, pubkey: normPk(ev.pubkey), created_at: ev.created_at, id: ev.id });
  return recomputeMods();
}

function recomputeMods() {
  const next = new Map();
  for (const m of state.modEvents) {
    if (!canPubkeyModerateEntry(m.pubkey, m.entry_id)) continue;
    const cur = next.get(m.entry_id);
    if (!cur || m.created_at > cur.created_at || (m.created_at === cur.created_at && m.id > cur.id)) next.set(m.entry_id, m);
  }
  if (mapSame(state.mods, next, modSame)) return false;
  state.mods = next;
  return true;
}

function recomputeUserBans() {
  const prev = state.userBans;
  const next = new Map();
  const now = nowSec();

  const sorted = [...state.userModEvents].sort((a, b) => (a.created_at !== b.created_at ? a.created_at - b.created_at : a.id.localeCompare(b.id)));
  for (const event of sorted) {
    if (!isPubkeyAdmin(event.pubkey)) continue;

    if (event.action === "unban") {
      next.delete(event.target_pubkey);
      continue;
    }

    if (event.action === "temp_ban") {
      if (!event.until_ts || event.until_ts <= now) {
        next.delete(event.target_pubkey);
        continue;
      }
      next.set(event.target_pubkey, {
        action: "temp_ban",
        until_ts: event.until_ts,
        created_at: event.created_at,
        id: event.id,
      });
      continue;
    }

    next.set(event.target_pubkey, {
      action: "ban",
      until_ts: 0,
      created_at: event.created_at,
      id: event.id,
    });
  }

  if (mapSame(prev, next, banSame)) return false;
  state.userBans = next;
  return true;
}

function recomputeNameClaims() {
  const prevNameOwners = state.nameOwnerByName;
  const prevNamesByPub = state.nameByPubkey;

  const byName = new Map();
  const sorted = [...state.nameClaimEvents].sort((a, b) => (a.created_at !== b.created_at ? a.created_at - b.created_at : a.id.localeCompare(b.id)));
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
    const current = byPubInfo.get(claim.pubkey);
    if (!current || claim.created_at > current.created_at || (claim.created_at === current.created_at && claim.id > current.id)) {
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

  state.nameOwnerByName = byName;
  state.nameByPubkey = byPub;

  const changed = !mapSame(prevNameOwners, byName, nameOwnerSame) || !mapSame(prevNamesByPub, byPub, (a, b) => a === b);
  if (changed && state.identity) {
    const owner = ownerPubkeyForName(state.identity.name);
    if (owner && owner !== state.identity.pubkey) {
      setStatus(`name @${state.identity.name} is owned by ${shortPk(owner)}`);
    }
  }
  return changed;
}

function applySnapshot(ev) {
  const p = parseObj(ev.content);
  if (!p || !Array.isArray(p.entries)) return false;
  const version_ts = unixOr(p.version_ts || firstTag(ev, "version"), ev.created_at);
  const admin_pubkey = normPk(p.admin_pubkey || "");
  const entries = [];
  const dedupe = new Map();
  for (const raw of p.entries) {
    const e = normEntry(raw);
    if (e) dedupe.set(e.entry_id, e);
  }
  for (const e of dedupe.values()) entries.push(e);
  state.snapshotEvents.push({ ev, version_ts, admin_pubkey, entries });
  return recomputeSnapshotChoice();
}

function applySnapshotRequest(ev) {
  const p = parseObj(ev.content);
  if (!p) return false;
  const request_id = cleanRequestId(p.request_id || firstTag(ev, "req"));
  if (!request_id) return false;
  if (state.snapshotRequestsSeen.has(request_id)) return false;
  state.snapshotRequestsSeen.add(request_id);

  if (!state.identity || !isAdminMe()) return false;
  if (!state.snapshot?.entries?.length) return false;
  if (ev.pubkey === state.identity.pubkey) return false;
  void respondToSnapshotRequest(request_id);
  return false;
}

async function requestSnapshotFromPeers() {
  if (!state.identity) return "";
  const request_id = cleanRequestId(`req-${state.identity.pubkey.slice(0, 8)}-${Date.now().toString(36)}`);
  if (!request_id) return "";
  const payload = {
    request_id,
    requested_by: state.identity.name,
    requested_at: nowSec(),
  };
  const ev = await signEvent(APP.kinds.snapshotRequest, [["d", "snapshot-request"], ["req", request_id]], payload);
  if (!ev) return "";

  const ok = await publishEvent(ev);
  ingestEvent(ev);
  setStatus(`snapshot request ${ok}/${APP.relays.length}`);
  return request_id;
}

async function respondToSnapshotRequest(request_id) {
  if (!state.identity || !isAdminMe()) return 0;
  if (!state.snapshot?.entries?.length) return 0;
  const req = cleanRequestId(request_id);
  if (!req) return 0;
  const version_ts = Math.max(unixOr(state.snapshot.version_ts, 0), nowSec());
  const payload = buildSnapshotPayload(version_ts);
  payload.response_to = req;
  const ev = await signEvent(APP.kinds.snapshot, [["d", "seed"], ["version", String(version_ts)], ["req", req]], payload);
  if (!ev) return 0;
  const ok = await publishEvent(ev);
  ingestEvent(ev);
  renderList();
  setStatus(`snapshot response ${ok}/${APP.relays.length}`);
  return ok;
}

function recomputeSnapshotChoice() {
  const prevId = state.snapshot?.event_id || "";
  const prevV = state.snapshot?.version_ts || 0;
  let win = null;
  if (hasAdmin()) {
    for (const s of state.snapshotEvents) {
      if (!isPubkeyAdmin(normPk(s.ev.pubkey))) continue;
      if (s.admin_pubkey && s.admin_pubkey !== state.admin.pubkey) continue;
      if (!win || s.version_ts > win.version_ts || (s.version_ts === win.version_ts && (s.ev.created_at > win.ev.created_at || (s.ev.created_at === win.ev.created_at && s.ev.id > win.ev.id)))) {
        win = s;
      }
    }
  }
  if (!win) {
    state.snapshot = null;
    return prevId !== "";
  }
  state.snapshot = { event_id: win.ev.id, version_ts: win.version_ts, entries: win.entries };
  cacheRecoveryDoc(buildRecoveryDoc(win.ev, win.version_ts));
  return prevId !== state.snapshot.event_id || prevV !== state.snapshot.version_ts;
}

function renderList() {
  el.list.replaceChildren();
  if (!state.identity) return;
  const rows = buildRows();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "drop the first track";
    el.list.appendChild(empty);
    return;
  }
  for (const row of rows) el.list.appendChild(renderRow(row));
}

function buildRows() {
  const merged = new Map();
  for (const e of (state.snapshot ? state.snapshot.entries : DEFAULT_SNAPSHOT.map((x) => ({ ...x })))) merged.set(e.entry_id, e);
  for (const e of state.entries.values()) merged.set(e.entry_id, e);

  const out = [];
  for (const e of merged.values()) {
    const owner_pubkey = isHex64(normPk(e.pubkey || "")) ? normPk(e.pubkey) : "";
    const ownerBanned = owner_pubkey ? Boolean(activeBanForPubkey(owner_pubkey)) : false;
    const revoked = state.mods.get(e.entry_id)?.action === "revoke";
    const ownerCanSee = Boolean(state.identity && owner_pubkey && owner_pubkey === state.identity.pubkey);
    const adminCanSee = isAdminMe() && state.showRevoked;
    if (revoked && !(adminCanSee || ownerCanSee)) continue;
    if (ownerBanned && !(adminCanSee || ownerCanSee)) continue;
    const map = state.votes.get(e.entry_id) || new Map();
    let score = 0;
    let myVote = 0;
    const upvoters = [];
    for (const [pk, v] of map.entries()) {
      if (activeBanForPubkey(pk)) continue;
      score += v.value;
      if (v.value > 0) upvoters.push(v.user || resolveName(pk));
      if (state.identity && pk === state.identity.pubkey) myVote = v.value;
    }
    out.push({
      ...e,
      owner_pubkey,
      owner_banned: ownerBanned,
      revoked,
      score,
      myVote,
      upvoters: uniqNames(upvoters),
    });
  }

  out.sort((a, b) => (b.score !== a.score ? b.score - a.score : b.created_at !== a.created_at ? b.created_at - a.created_at : a.title.localeCompare(b.title)));
  return out;
}

function renderRow(r) {
  const item = document.createElement("article");
  item.className = r.revoked ? "item revoked" : "item";

  const main = document.createElement("div");
  main.className = "item-main";
  const line = document.createElement("div");
  line.className = "line";

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = r.title;
  const artist = document.createElement("span");
  artist.className = "artist";
  artist.textContent = r.artist;
  const author = document.createElement("button");
  author.className = "author";
  author.type = "button";
  const resolvedName = r.owner_pubkey ? resolveName(r.owner_pubkey) : normName(r.user || "anon");
  author.textContent = `@${resolvedName}${r.owner_banned ? " [banned]" : ""}`;
  if (r.owner_pubkey) {
    author.classList.add("clickable");
    author.addEventListener("click", () => openUserModal(r.owner_pubkey, resolvedName, r));
    item.classList.add("item-clickable");
    item.addEventListener("click", (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest("button")) return;
      openUserModal(r.owner_pubkey, resolvedName, r);
    });
  } else {
    author.disabled = true;
  }
  const time = document.createElement("span");
  time.className = "time";
  time.textContent = fmtDate(r.created_at);

  if (r.youtube_id) {
    const play = document.createElement("button");
    play.type = "button";
    const active = state.youtube.currentEntryId === r.entry_id && state.youtube.isPlaying;
    play.className = active ? "play-btn active" : "play-btn";
    play.title = active ? "pause" : "play";
    play.textContent = active ? "||" : "\u25b6";
    play.addEventListener("click", () => void onPlayToggle(r.entry_id, r.youtube_id));
    line.appendChild(play);
  }

  line.append(title, artist, author, time);
  if (isAdminMe() && !r.revoked) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "item-delete-btn";
    del.title = "delete song";
    del.setAttribute("aria-label", "delete song");
    del.appendChild(createTrashIcon());
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      openDeleteConfirm(r);
    });
    line.appendChild(del);
  }

  const ups = document.createElement("div");
  ups.className = "upvoters";
  ups.textContent = r.upvoters.join(" · ");
  main.append(line, ups);

  const vs = document.createElement("div");
  vs.className = "vote-stack";
  const vb = document.createElement("div");
  vb.className = "vote-buttons";

  const up = document.createElement("button");
  up.type = "button";
  up.className = r.myVote > 0 ? "vote up active" : "vote up";
  up.textContent = "\u25b2";
  up.disabled = !state.identity || Boolean(activeBanForPubkey(state.identity?.pubkey || ""));
  up.addEventListener("click", () => void castVote(r.entry_id, 1));

  const down = document.createElement("button");
  down.type = "button";
  down.className = r.myVote < 0 ? "vote down active" : "vote down";
  down.textContent = "\u25bc";
  down.disabled = !state.identity || Boolean(activeBanForPubkey(state.identity?.pubkey || ""));
  down.addEventListener("click", () => void castVote(r.entry_id, -1));

  vb.append(up, down);
  const score = document.createElement("div");
  score.className = "score";
  score.textContent = String(r.score);
  vs.append(vb, score);

  item.append(main, vs);
  return item;
}

function createTrashIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M9 3h6l1 2h4v2H4V5h4l1-2zm-2 6h2v9H7V9zm4 0h2v9h-2V9zm4 0h2v9h-2V9zM6 7h12l-1 14H7L6 7z");
  svg.appendChild(path);
  return svg;
}

async function onEntrySubmit(e) {
  e.preventDefault();
  if (!state.identity) return setStatus("sign in first");
  const meBan = activeBanForPubkey(state.identity.pubkey);
  if (meBan) {
    return setStatus(meBan.until_ts ? `banned until ${fmtDate(meBan.until_ts)}` : "banned");
  }
  const title = cleanText(el.titleInput.value, 120);
  const artist = cleanText(el.artistInput.value, 120);
  const youtubeRaw = cleanText(el.youtubeInput.value, 300);
  const youtube_id = youtubeIdFromAny(youtubeRaw);
  const youtube_url = youtube_id ? canonicalYouTubeUrl(youtube_id) : "";
  if (!title || !artist) return;
  if (youtubeRaw && !youtube_id) return setStatus("invalid youtube url");

  const created_at = nowSec();
  const entry_id = `entry:${state.identity.pubkey.slice(0, 8)}:${Date.now().toString(36)}`;
  const payload = { entry_id, title, artist, youtube_id, youtube_url, user: state.identity.name, created_at };
  const tags = [["d", entry_id]];
  if (youtube_id) tags.push(["yt", youtube_id]);
  const ev = await signEvent(APP.kinds.entry, tags, payload);
  if (!ev) return;

  const ok = await publishEvent(ev);
  ingestEvent(ev);
  el.titleInput.value = "";
  el.artistInput.value = "";
  el.youtubeInput.value = "";
  closeModal(el.addSongModal);
  renderList();
  setStatus(`published ${ok}/${APP.relays.length}`);
}

async function castVote(entry_id, targetValue) {
  if (!state.identity) return setStatus("sign in first");
  const meBan = activeBanForPubkey(state.identity.pubkey);
  if (meBan) {
    return setStatus(meBan.until_ts ? `banned until ${fmtDate(meBan.until_ts)}` : "banned");
  }
  const m = state.votes.get(entry_id);
  const cur = m?.get(state.identity.pubkey)?.value || 0;
  const next = cur === targetValue ? 0 : targetValue;

  const payload = { entry_id, value: next, user: state.identity.name, created_at: nowSec() };
  const ev = await signEvent(APP.kinds.vote, [["d", entry_id], ["v", String(next)]], payload);
  if (!ev) return;

  const ok = await publishEvent(ev);
  ingestEvent(ev);
  renderList();
  setStatus(`published ${ok}/${APP.relays.length}`);
}

async function toggleRevoke(entry_id, revoked) {
  if (!state.identity) return setStatus("sign in first");
  if (!canPubkeyModerateEntry(state.identity.pubkey, entry_id)) return setStatus("not allowed");
  const action = revoked ? "restore" : "revoke";
  const payload = { entry_id, action, created_at: nowSec() };
  const ev = await signEvent(APP.kinds.mod, [["d", entry_id], ["op", action]], payload);
  if (!ev) return;

  const ok = await publishEvent(ev);
  ingestEvent(ev);
  renderList();
  setStatus(`published ${ok}/${APP.relays.length}`);
}

async function onClaimAdmin() {
  if (!state.identity) return setStatus("sign in first");
  if (hasAdmin()) return setStatus(`admin already set: ${shortPk(state.admin.pubkey)}`);

  const claimed_at = nowSec();
  const payload = {
    admin_pubkey: state.identity.pubkey,
    claimed_by: state.identity.name,
    claimed_at,
    protocol: "nk3-admin-claim-v1",
  };

  const ev = await signEvent(APP.kinds.adminClaim, [["d", "admin-claim"], ["admin", state.identity.pubkey], ["version", String(claimed_at)]], payload);
  if (!ev) return;

  const ok = await publishEvent(ev);
  ingestEvent(ev);
  renderIdentity();
  renderWizard();
  renderList();
  setStatus(`admin claim published ${ok}/${APP.relays.length}`);
}

async function onAdminRoleChange(action) {
  if (!state.identity) return setStatus("sign in first");
  if (!isAdminMe()) return setStatus("admin only");
  if (!hasAdmin()) return setStatus("no admin claim yet");

  const target = normPk(el.adminPubkeyInput?.value || "");
  if (!isHex64(target)) return setStatus("target pubkey must be 64 hex");
  if (action === "revoke" && target === state.admin.pubkey) return setStatus("cannot revoke root admin");
  const ok = await publishAdminRole(action, target);
  setStatus(`admin ${action} published ${ok}/${APP.relays.length}`);
}

function openDeleteConfirm(row) {
  if (!state.identity) return setStatus("sign in first");
  if (!isAdminMe()) return setStatus("admin only");
  const entry_id = cleanEntryId(row?.entry_id || "");
  if (!entry_id) return setStatus("invalid entry");
  const title = cleanText(row?.title || "", 120) || "song";
  const artist = cleanText(row?.artist || "", 120) || "unknown";
  state.deleteConfirmContext = { entry_id, title, artist };
  if (el.deleteConfirmText) {
    el.deleteConfirmText.textContent = `Delete "${title}" by ${artist}?`;
  }
  openModal(el.deleteConfirmModal);
}

async function onConfirmDelete() {
  if (!state.identity) return setStatus("sign in first");
  if (!isAdminMe()) return setStatus("admin only");
  const ctx = state.deleteConfirmContext;
  const entryId = cleanEntryId(ctx?.entry_id || "");
  if (!entryId) return setStatus("select a song first");
  const revoked = Boolean(state.mods.get(entryId)?.action === "revoke");
  await toggleRevoke(entryId, revoked);
  closeModal(el.deleteConfirmModal);
}

async function onUserModalBanChange(action) {
  if (!state.identity) return setStatus("sign in first");
  if (!isAdminMe()) return setStatus("admin only");
  if (!hasAdmin()) return setStatus("no admin claim yet");
  const ctx = state.userModalContext;
  const target = normPk(ctx?.pubkey || "");
  if (!isHex64(target)) return setStatus("target pubkey missing");
  if (target === state.admin.pubkey && action !== "unban") return setStatus("cannot ban root admin");

  let minutes = 0;
  if (action === "temp_ban") {
    const minutesRaw = Number(el.userModalTempBanMinutesInput?.value || 0);
    if (!Number.isFinite(minutesRaw) || minutesRaw <= 0) return setStatus("temp minutes required");
    minutes = Math.floor(minutesRaw);
  }

  const ok = await publishUserMod(action, target, minutes);
  refreshUserModalContext();
  renderUserModalModeration();
  setStatus(`user ${action} published ${ok}/${APP.relays.length}`);
}

async function ensureNameClaimForCurrentUser(desiredNameInput) {
  if (!state.identity) return false;
  const name = normName(desiredNameInput || state.identity.name);
  if (!name) return false;

  const owner = ownerPubkeyForName(name);
  if (owner && owner !== state.identity.pubkey) return false;
  const already = state.nameByPubkey.get(state.identity.pubkey);
  if (already === name) {
    setIdentityName(name);
    return true;
  }

  const payload = { name, pubkey: state.identity.pubkey, created_at: nowSec() };
  const ev = await signEvent(APP.kinds.nameClaim, [["d", "name-claim"], ["name", name]], payload);
  if (!ev) return false;
  await publishEvent(ev);
  ingestEvent(ev);
  setIdentityName(name);
  return true;
}

async function publishAdminRole(action, target_pubkey) {
  if (!state.identity) throw new Error("sign in first");
  const target = normPk(target_pubkey || "");
  if (!isHex64(target)) throw new Error("target pubkey must be 64 hex");
  if (action === "revoke" && target === state.admin.pubkey) throw new Error("cannot revoke root admin");
  const payload = {
    action,
    target_pubkey: target,
    changed_by: state.identity.name,
    created_at: nowSec(),
  };
  const ev = await signEvent(APP.kinds.adminRole, [["d", "admin-role"], ["p", target], ["op", action]], payload);
  if (!ev) return 0;
  const ok = await publishEvent(ev);
  ingestEvent(ev);
  renderIdentity();
  renderWizard();
  renderList();
  return ok;
}

async function publishUserMod(action, target_pubkey, tempMinutes) {
  if (!state.identity) throw new Error("sign in first");
  const target = normPk(target_pubkey || "");
  if (!isHex64(target)) throw new Error("target pubkey must be 64 hex");
  if (target === state.admin.pubkey && action !== "unban") throw new Error("cannot ban root admin");

  let until_ts = 0;
  if (action === "temp_ban") {
    const minutes = Math.floor(Number(tempMinutes || 0));
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error("temp minutes required");
    until_ts = nowSec() + (minutes * 60);
  }

  const payload = {
    action,
    target_pubkey: target,
    until_ts,
    changed_by: state.identity.name,
    created_at: nowSec(),
  };
  const tags = [["d", "user-mod"], ["p", target], ["op", action]];
  if (until_ts) tags.push(["until", String(until_ts)]);

  const ev = await signEvent(APP.kinds.userMod, tags, payload);
  if (!ev) return 0;
  const ok = await publishEvent(ev);
  ingestEvent(ev);
  renderIdentity();
  renderList();
  return ok;
}

function onDownloadKeys() {
  if (!state.identity) return setStatus("sign in first");
  const out = {
    protocol: "nk3-key-export/v1",
    exported_at: nowSec(),
    app_tag: APP.tag,
    name: state.identity.name,
    auth: "password-derived",
    pubkey: state.identity.pubkey,
    secret_key_hex: state.identity.secretKeyHex,
    is_admin: isAdminMe(),
  };
  download(`nk3-keys-${safeFile(state.identity.name)}-${nowSec()}.json`, JSON.stringify(out, null, 2), "application/json");
  setStatus("keys downloaded");
}

async function onProfileSave(event) {
  event.preventDefault();
  if (!state.identity) return setStatus("sign in first");

  const desiredName = normName(el.profileNameInput?.value || state.identity.name);
  const social = cleanSocial(el.profileSocialInput?.value || "");
  const bio = cleanBio(el.profileBioInput?.value || "");
  if (!desiredName) return setStatus("alias required");

  const owner = ownerPubkeyForName(desiredName);
  if (owner && owner !== state.identity.pubkey) {
    return setStatus(`name @${desiredName} taken by ${shortPk(owner)}`);
  }

  const nameOk = await ensureNameClaimForCurrentUser(desiredName);
  if (!nameOk) return setStatus(`name @${desiredName} unavailable`);

  const payload = {
    name: desiredName,
    social,
    bio,
    updated_at: nowSec(),
  };
  const ev = await signEvent(APP.kinds.profile, [["d", "profile"]], payload);
  if (!ev) return;
  const ok = await publishEvent(ev);
  ingestEvent(ev);
  closeModal(el.profileModal);
  renderIdentity();
  renderList();
  setStatus(`profile saved ${ok}/${APP.relays.length}`);
}

async function onPublishSnapshot() {
  if (!isAdminMe()) return setStatus("admin only");

  const version_ts = nowSec();
  const payload = buildSnapshotPayload(version_ts);
  const snapEv = await signEvent(APP.kinds.snapshot, [["d", "seed"], ["version", String(version_ts)]], payload);
  if (!snapEv) return;

  let backupUrl = "";
  try {
    const doc = buildRecoveryDoc(snapEv, version_ts);
    backupUrl = await uploadRecoveryDoc(doc);
    rememberBackup(backupUrl, version_ts);
    cacheRecoveryDoc(doc);
    el.recoveryUrl.value = backupUrl;
    renderBackupMeta();
  } catch (err) {
    console.error(err);
    setStatus(`snapshot upload failed: ${err.message || String(err)}`);
  }

  const ok = await publishEvent(snapEv);
  ingestEvent(snapEv);
  renderList();
  if (backupUrl) {
    const restoreLink = `${window.location.origin}${window.location.pathname}?backup=${encodeURIComponent(backupUrl)}`;
    void copyText(restoreLink);
    setStatus(`snapshot v${version_ts} published ${ok}/${APP.relays.length} + paste + restore link copied`);
  } else {
    setStatus(`snapshot v${version_ts} published ${ok}/${APP.relays.length}`);
  }
}

function buildSnapshotPayload(version_ts) {
  const entries = buildRows()
    .filter((r) => !r.revoked)
    .map((r) => ({
      entry_id: r.entry_id,
      title: r.title,
      artist: r.artist,
      youtube_id: r.youtube_id || "",
      youtube_url: r.youtube_id ? canonicalYouTubeUrl(r.youtube_id) : "",
      pubkey: isHex64(normPk(r.owner_pubkey || r.pubkey || "")) ? normPk(r.owner_pubkey || r.pubkey) : "",
      user: r.user,
      created_at: r.created_at,
    }));

  return {
    entries,
    version_ts,
    admin_pubkey: state.admin.pubkey,
    seeded_by: state.identity?.name || "unknown",
    seeded_at: nowSec(),
  };
}

function buildRecoveryDoc(snapshotEvent, version_ts) {
  const adminRoles = state.adminRoleEvents
    .map((x) => x.ev)
    .filter((x) => x && x.id)
    .sort((a, b) => (a.created_at !== b.created_at ? a.created_at - b.created_at : a.id.localeCompare(b.id)));
  const userMods = state.userModEvents
    .map((x) => x.ev)
    .filter((x) => x && x.id)
    .sort((a, b) => (a.created_at !== b.created_at ? a.created_at - b.created_at : a.id.localeCompare(b.id)));
  const nameClaims = state.nameClaimEvents
    .map((x) => x.ev)
    .filter((x) => x && x.id)
    .sort((a, b) => (a.created_at !== b.created_at ? a.created_at - b.created_at : a.id.localeCompare(b.id)));
  const profiles = state.profileEvents
    .map((x) => x.ev)
    .filter((x) => x && x.id)
    .sort((a, b) => (a.created_at !== b.created_at ? a.created_at - b.created_at : a.id.localeCompare(b.id)));

  return {
    protocol: RECOVERY_PROTOCOL,
    app_tag: APP.tag,
    generated_at: nowSec(),
    version_ts,
    admin_pubkey: state.admin.pubkey,
    events: {
      admin_claim: state.admin.claimEvent || null,
      admin_roles: adminRoles,
      user_mods: userMods,
      name_claims: nameClaims,
      profiles,
      snapshot: snapshotEvent,
    },
  };
}

async function uploadRecoveryDoc(doc) {
  const body = new URLSearchParams();
  body.set("content", JSON.stringify(doc, null, 2));
  body.set("syntax", "json");
  body.set("title", `nk3-${doc.version_ts}`);

  const res = await fetch(APP.pasteUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`paste upload failed ${res.status}`);

  const url = normBackupUrl(await res.text());
  if (!url) throw new Error("invalid paste url");
  return url;
}

async function onRestoreBackup() {
  const url = normBackupUrl(el.recoveryUrl.value);
  if (!url) return setStatus("paste url required");
  await restoreBackupUrl(url, true, false);
}

async function onImportFile() {
  const file = el.backupFileInput.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const doc = parseRecoveryText(text);
    if (!doc) return setStatus("invalid recovery file");
    const changed = importRecoveryDoc(doc, { source: file.name, silent: false, cache: true });
    if (changed) {
      renderIdentity();
      renderWizard();
      renderList();
    }
  } catch (err) {
    console.error(err);
    setStatus(`file import failed: ${err.message || String(err)}`);
  } finally {
    el.backupFileInput.value = "";
  }
}

async function tryRestoreBootstrap() {
  const q = new URLSearchParams(window.location.search);
  const fromQuery = normBackupUrl(q.get("backup") || q.get("snapshot") || "");
  if (fromQuery) {
    el.recoveryUrl.value = fromQuery;
    if (await restoreBackupUrl(fromQuery, true, false)) return;
  }

  const tried = new Set();
  const staticBackups = Array.isArray(APP.bootstrapBackupUrls) ? APP.bootstrapBackupUrls : [];
  const candidates = [...state.backups.map((b) => b.url), ...staticBackups.map((u) => normBackupUrl(u))];
  for (const candidate of candidates) {
    const url = normBackupUrl(candidate);
    if (!url || tried.has(url)) continue;
    tried.add(url);
    if (await restoreBackupUrl(url, false, true)) return;
  }
}

async function restoreBackupUrl(url, remember, quiet) {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`backup fetch failed ${res.status}`);

    const doc = parseRecoveryText(await res.text());
    if (!doc) throw new Error("backup format invalid");

    const changed = importRecoveryDoc(doc, { source: url, silent: false, cache: true });
    if (remember) {
      rememberBackup(url, unixOr(doc.version_ts, nowSec()));
      renderBackupMeta();
    }
    if (changed) {
      renderIdentity();
      renderWizard();
      renderList();
    }
    return true;
  } catch (err) {
    if (!quiet) {
      console.error(err);
      setStatus(`restore failed: ${err.message || String(err)}`);
    }
    return false;
  }
}

function parseRecoveryText(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.protocol === RECOVERY_PROTOCOL) return parsed;

  if (parsed.kind === APP.kinds.snapshot && parsed.id && parsed.pubkey && parsed.sig) {
    return {
      protocol: RECOVERY_PROTOCOL,
      app_tag: APP.tag,
      generated_at: nowSec(),
      version_ts: unixOr(firstTag(parsed, "version"), parsed.created_at),
      admin_pubkey: normPk(parsed.pubkey),
      events: { admin_claim: null, snapshot: parsed },
    };
  }

  return null;
}

function importRecoveryDoc(doc, { source = "recovery", silent = false, cache = true } = {}) {
  if (!doc || typeof doc !== "object") return false;
  if (doc.app_tag && doc.app_tag !== APP.tag) {
    if (!silent) setStatus("backup app tag mismatch");
    return false;
  }

  let changed = false;
  const events = doc.events && typeof doc.events === "object" ? doc.events : {};
  if (events.admin_claim) changed = ingestEvent(events.admin_claim) || changed;
  if (Array.isArray(events.admin_roles)) {
    for (const roleEvent of events.admin_roles) {
      changed = ingestEvent(roleEvent) || changed;
    }
  }
  if (Array.isArray(events.user_mods)) {
    for (const modEvent of events.user_mods) {
      changed = ingestEvent(modEvent) || changed;
    }
  }
  if (Array.isArray(events.name_claims)) {
    for (const nameEvent of events.name_claims) {
      changed = ingestEvent(nameEvent) || changed;
    }
  }
  if (Array.isArray(events.profiles)) {
    for (const profileEvent of events.profiles) {
      changed = ingestEvent(profileEvent) || changed;
    }
  }
  if (events.snapshot) changed = ingestEvent(events.snapshot) || changed;

  if (cache) cacheRecoveryDoc(doc);
  if (!silent) {
    const v = unixOr(doc.version_ts, nowSec());
    setStatus(changed ? `restored v${v} from ${source}` : `backup read v${v} from ${source}`);
  }
  return changed;
}

function rememberBackup(url, version_ts) {
  const x = normBackupUrl(url);
  if (!x) return;

  const next = state.backups.filter((b) => b.url !== x);
  next.unshift({ url: x, version_ts: unixOr(version_ts, 0), touched_at: nowSec() });
  next.sort((a, b) => (b.version_ts !== a.version_ts ? b.version_ts - a.version_ts : b.touched_at - a.touched_at));

  state.backups = next.slice(0, 24);
  localStorage.setItem(STORAGE_BACKUPS, JSON.stringify(state.backups));
  sharedCachePersistMeta(SHARED_CACHE_META_BACKUPS, state.backups);
}

function cacheRecoveryDoc(doc) {
  try {
    localStorage.setItem(STORAGE_RECOVERY, JSON.stringify(doc));
    sharedCachePersistMeta(SHARED_CACHE_META_RECOVERY, doc);
  } catch (err) {
    console.error(err);
  }
}

async function onPlayToggle(entry_id, youtube_id) {
  if (!youtube_id) return;
  try {
    const player = await ensureYouTubePlayer(youtube_id);
    const sameEntry = state.youtube.currentEntryId === entry_id;
    const sameVideo = state.youtube.currentVideoId === youtube_id;

    if (sameEntry && state.youtube.isPlaying) {
      player.pauseVideo();
      state.youtube.isPlaying = false;
      queueRender();
      return;
    }

    if (!sameEntry || !sameVideo) {
      player.loadVideoById(youtube_id);
    } else {
      player.playVideo();
    }

    state.youtube.currentEntryId = entry_id;
    state.youtube.currentVideoId = youtube_id;
    state.youtube.isPlaying = true;
    queueRender();
  } catch (err) {
    console.error(err);
    setStatus("youtube player unavailable");
  }
}

function ensureYouTubeApi() {
  if (window.YT?.Player) {
    return Promise.resolve(window.YT);
  }
  if (state.youtube.apiPromise) {
    return state.youtube.apiPromise;
  }

  state.youtube.apiPromise = new Promise((resolve, reject) => {
    let done = false;
    const finish = (value, error) => {
      if (done) return;
      done = true;
      if (error) reject(error);
      else resolve(value);
    };

    const timeout = setTimeout(() => finish(null, new Error("youtube api timeout")), 15000);
    const prevReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      clearTimeout(timeout);
      try {
        if (typeof prevReady === "function") prevReady();
      } catch {
        // Keep going even if previous hook fails.
      }
      finish(window.YT, null);
    };

    let script = document.getElementById("youtube-iframe-api");
    if (!script) {
      script = document.createElement("script");
      script.id = "youtube-iframe-api";
      script.src = "https://www.youtube.com/iframe_api";
      script.async = true;
      script.onerror = () => {
        clearTimeout(timeout);
        finish(null, new Error("youtube api failed to load"));
      };
      document.head.appendChild(script);
    }

    if (window.YT?.Player) {
      clearTimeout(timeout);
      finish(window.YT, null);
    }
  });
  state.youtube.apiPromise = state.youtube.apiPromise.catch((error) => {
    state.youtube.apiPromise = null;
    throw error;
  });
  return state.youtube.apiPromise;
}

async function ensureYouTubePlayer(initialVideoId) {
  if (state.youtube.playerPromise) {
    return state.youtube.playerPromise;
  }
  if (!el.ytPlayerHost) {
    throw new Error("youtube host missing");
  }

  state.youtube.playerPromise = (async () => {
    const YT = await ensureYouTubeApi();
    return new Promise((resolve, reject) => {
      let player;
      player = new YT.Player(el.ytPlayerHost, {
        width: "1",
        height: "1",
        videoId: initialVideoId,
        playerVars: {
          controls: 0,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
        },
        events: {
          onReady: () => {
            state.youtube.player = player;
            resolve(player);
          },
          onStateChange: onYouTubeStateChange,
          onError: () => {
            state.youtube.isPlaying = false;
            queueRender();
            setStatus("youtube playback failed");
          },
        },
      });
      setTimeout(() => {
        if (!state.youtube.player) {
          reject(new Error("youtube player init timeout"));
        }
      }, 15000);
    });
  })();

  state.youtube.playerPromise = state.youtube.playerPromise.catch((error) => {
    state.youtube.playerPromise = null;
    state.youtube.player = null;
    throw error;
  });
  return state.youtube.playerPromise;
}

function onYouTubeStateChange(event) {
  const code = Number(event?.data);
  const states = window.YT?.PlayerState;
  if (!states) return;

  if (code === states.PLAYING) {
    state.youtube.isPlaying = true;
  } else if (code === states.PAUSED || code === states.CUED) {
    state.youtube.isPlaying = false;
  } else if (code === states.ENDED) {
    state.youtube.isPlaying = false;
    state.youtube.currentEntryId = "";
    state.youtube.currentVideoId = "";
  }
  queueRender();
}

async function signEvent(kind, tags, payload) {
  if (!state.identity) {
    setStatus("sign in first");
    return null;
  }
  if (!isHex64(state.identity.secretKeyHex || "")) {
    setStatus("password sign-in required");
    return null;
  }

  const unsigned = {
    kind,
    created_at: nowSec(),
    tags: [["t", APP.tag], ...tags],
    content: JSON.stringify(payload),
  };

  try {
    const ev = finalizeEvent(unsigned, hexToBytes(state.identity.secretKeyHex));
    if (!verifyEvent(ev)) throw new Error("event signature invalid");
    return ev;
  } catch (err) {
    console.error(err);
    setStatus(`sign failed: ${err.message || String(err)}`);
    return null;
  }
}

async function publishEvent(ev) {
  try {
    const out = await Promise.allSettled(pool.publish(APP.relays, ev));
    return out.filter((r) => r.status === "fulfilled").length;
  } catch (err) {
    console.error(err);
    return 0;
  }
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
  });
}

function hasTag(ev, key, val) {
  return ev.tags?.some((t) => t[0] === key && t[1] === val);
}

function firstTag(ev, key) {
  const hit = ev.tags?.find((t) => t[0] === key);
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

function normEntry(raw) {
  if (!raw || typeof raw !== "object") return null;
  const entry_id = cleanEntryId(raw.entry_id || raw.id);
  const title = cleanText(raw.title, 120);
  const artist = cleanText(raw.artist, 120);
  const youtube_id = youtubeIdFromAny(raw.youtube_id || raw.youtube_url);
  const youtube_url = youtube_id ? canonicalYouTubeUrl(youtube_id) : "";
  const pubkey = isHex64(normPk(raw.pubkey || "")) ? normPk(raw.pubkey) : "";
  const user = normName(raw.user || "seed");
  const created_at = unixOr(raw.created_at, nowSec());
  if (!entry_id || !title || !artist) return null;
  return { entry_id, title, artist, youtube_id, youtube_url, pubkey, user, created_at };
}

function resolveName(pubkey) {
  const claimed = state.nameByPubkey.get(normPk(pubkey || ""));
  if (claimed) return claimed;
  const hit = state.usernames.get(pubkey);
  if (hit) return hit.name;
  if (state.identity && pubkey === state.identity.pubkey) return state.identity.name;
  return shortPk(pubkey);
}

function rememberName(pubkey, name, created_at) {
  if (!isHex64(pubkey)) return;
  const clean = normName(name);
  if (!clean) return;
  const cur = state.usernames.get(pubkey);
  if (!cur || cur.created_at <= created_at) state.usernames.set(pubkey, { name: clean, created_at });
}

function uniqNames(list) {
  const seen = new Set();
  const out = [];
  for (const x of list) {
    const clean = normName(x || "");
    if (!clean || seen.has(clean)) continue;
    seen.add(clean);
    out.push(clean);
  }
  return out;
}

function cleanRequestId(v) {
  const out = String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, "")
    .slice(0, 80);
  return out || "";
}

function cleanText(v, max) {
  return String(v || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanBio(v) {
  return String(v || "").replace(/\r/g, "").trim().slice(0, 320);
}

function cleanSocial(v) {
  return String(v || "").trim().slice(0, 220);
}

function socialToHref(v) {
  const raw = cleanSocial(v);
  if (!raw) return "";
  try {
    const direct = new URL(raw);
    if (direct.protocol === "http:" || direct.protocol === "https:") {
      return direct.toString();
    }
  } catch {
    // Continue to fallback.
  }
  try {
    const fallback = new URL(`https://${raw}`);
    return fallback.toString();
  } catch {
    return "";
  }
}

function normName(v) {
  return String(v || "").trim().replace(/^@+/, "").slice(0, 32);
}

function cleanEntryId(v) {
  const x = String(v || "").trim().toLowerCase().slice(0, 120);
  return x && /^[a-z0-9:_-]+$/.test(x) ? x : "";
}

function normPk(v) {
  return String(v || "").trim().toLowerCase();
}

function shortPk(v) {
  return v && v.length >= 12 ? `${v.slice(0, 8)}:${v.slice(-4)}` : "unknown";
}

function fmtDate(ts) {
  const d = new Date(unixOr(ts, nowSec()) * 1000);
  return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function unixOr(v, fb) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fb;
}

function clampVote(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n > 0) return 1;
  if (n < 0) return -1;
  return 0;
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

function setStatus(text) {
  const msg = String(text || "").trim();
  if (!msg) return;
  console.log(`[nk3] ${msg}`);
}

async function deriveSecretKey(passphrase) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    iterations: 210000,
    salt: enc.encode(`nk3:${APP.tag}:account-v2`),
  }, key, 256);
  return new Uint8Array(bits);
}

async function deriveLegacySecretKey(passphrase, name) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({
    name: "PBKDF2",
    hash: "SHA-256",
    iterations: 210000,
    salt: enc.encode(`nk3:${APP.tag}:${name.toLowerCase()}`),
  }, key, 256);
  return new Uint8Array(bits);
}

function bytesToHex(bytes) {
  return Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex) {
  const clean = String(hex || "").trim().toLowerCase();
  if (clean.length % 2 !== 0) throw new Error("hex length must be even");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    const next = Number.parseInt(clean.slice(i, i + 2), 16);
    if (!Number.isFinite(next)) throw new Error("invalid hex");
    out[i / 2] = next;
  }
  return out;
}

function isHex64(v) {
  return /^[a-f0-9]{64}$/.test(String(v || "").toLowerCase());
}

function youtubeIdFromAny(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";

  const direct = cleanYouTubeId(raw);
  if (direct) return direct;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return "";
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host === "youtu.be") {
    return cleanYouTubeId(url.pathname.split("/").filter(Boolean)[0] || "");
  }

  if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
    const byQuery = cleanYouTubeId(url.searchParams.get("v") || "");
    if (byQuery) return byQuery;

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "shorts" || parts[0] === "embed" || parts[0] === "live" || parts[0] === "v") {
      return cleanYouTubeId(parts[1] || "");
    }
  }

  return "";
}

function cleanYouTubeId(value) {
  const raw = String(value || "").trim();
  const base = raw.split(/[?&#/]/)[0];
  return /^[a-zA-Z0-9_-]{11}$/.test(base) ? base : "";
}

function canonicalYouTubeUrl(youtube_id) {
  return `https://www.youtube.com/watch?v=${youtube_id}`;
}

function hasAdmin() {
  return isHex64(state.admin.pubkey);
}

function isAdminMe() {
  return Boolean(state.identity && isPubkeyAdmin(state.identity.pubkey));
}

function isPubkeyAdmin(pubkey) {
  const clean = normPk(pubkey || "");
  return Boolean(clean && state.admins.has(clean));
}

function activeBanForPubkey(pubkey) {
  const clean = normPk(pubkey || "");
  if (!isHex64(clean)) return null;
  const ban = state.userBans.get(clean);
  if (!ban) return null;
  if (ban.until_ts && ban.until_ts <= nowSec()) return null;
  return ban;
}

function canPubkeyModerateEntry(pubkey, entry_id) {
  const cleanPk = normPk(pubkey || "");
  if (!isHex64(cleanPk)) return false;
  if (isPubkeyAdmin(cleanPk)) return true;
  const owner = ownerPubkeyForEntry(entry_id);
  return Boolean(owner && owner === cleanPk);
}

function ownerPubkeyForEntry(entry_id) {
  const live = state.entries.get(entry_id);
  if (live && isHex64(normPk(live.pubkey || ""))) {
    return normPk(live.pubkey);
  }
  if (state.snapshot?.entries) {
    for (const item of state.snapshot.entries) {
      if (item.entry_id !== entry_id) continue;
      if (isHex64(normPk(item.pubkey || ""))) return normPk(item.pubkey);
      break;
    }
  }
  return "";
}

function setSame(a, b) {
  if (a.size !== b.size) return false;
  for (const value of a.values()) {
    if (!b.has(value)) return false;
  }
  return true;
}

function mapSame(a, b, cmp) {
  if (a.size !== b.size) return false;
  for (const [k, v] of a.entries()) {
    if (!b.has(k) || !cmp(v, b.get(k))) return false;
  }
  return true;
}

function modSame(a, b) {
  return a.entry_id === b.entry_id && a.action === b.action && a.created_at === b.created_at && a.id === b.id;
}

function banSame(a, b) {
  return (
    a.action === b.action
    && a.until_ts === b.until_ts
    && a.created_at === b.created_at
    && a.id === b.id
  );
}

function normBackupUrl(raw) {
  if (!raw) return "";
  try {
    const u = new URL(String(raw).trim());
    u.hash = "";
    if (u.hostname === "dpaste.com") {
      const p = u.pathname.replace(/\/+$/, "");
      u.pathname = p.endsWith(".txt") ? p : `${p}.txt`;
      u.search = "";
    }
    return u.toString();
  } catch {
    return "";
  }
}

function download(filename, text, contentType) {
  const blob = new Blob([text], { type: contentType || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function copyText(text) {
  if (!navigator.clipboard?.writeText) {
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Ignore clipboard failures; backup URL is still shown in the input.
  }
}

function safeFile(v) {
  return String(v || "user").replace(/[^a-z0-9-_]+/gi, "_").slice(0, 40) || "user";
}

function ownerPubkeyForName(name) {
  const clean = normName(name || "");
  if (!clean) return "";
  return state.nameOwnerByName.get(clean)?.pubkey || "";
}

function nameOwnerSame(a, b) {
  return (
    a.name === b.name
    && a.pubkey === b.pubkey
    && a.created_at === b.created_at
    && a.id === b.id
  );
}

function installConsoleInterface() {
  window.NK3Admin = {
    snapshot: () => onPublishSnapshot(),
    requestSnapshot: () => requestSnapshotFromPeers(),
    restore: async (url) => {
      const clean = normBackupUrl(url || "");
      if (!clean) throw new Error("invalid backup url");
      return restoreBackupUrl(clean, true, false);
    },
    rehydrateCache: async () => hydrateFromSharedCache(),
    grantAdmin: async (pubkey) => {
      if (!isAdminMe()) throw new Error("admin only");
      return publishAdminRole("grant", pubkey);
    },
    removeAdmin: async (pubkey) => {
      if (!isAdminMe()) throw new Error("admin only");
      return publishAdminRole("revoke", pubkey);
    },
    ban: async (pubkey) => {
      if (!isAdminMe()) throw new Error("admin only");
      return publishUserMod("ban", pubkey, 0);
    },
    tempBan: async (pubkey, minutes) => {
      if (!isAdminMe()) throw new Error("admin only");
      return publishUserMod("temp_ban", pubkey, minutes);
    },
    unban: async (pubkey) => {
      if (!isAdminMe()) throw new Error("admin only");
      return publishUserMod("unban", pubkey, 0);
    },
    state: () => ({
      root_admin: state.admin.pubkey,
      admins: [...state.admins.values()],
      bans: [...state.userBans.entries()].map(([pubkey, ban]) => ({ pubkey, ...ban })),
      backup_latest: state.backups[0]?.url || "",
      shared_cache: {
        available: Boolean(state.sharedCache.port),
        connected: state.sharedCache.connected,
        pending: state.sharedCache.pending.size,
      },
    }),
  };
}

function setIdentityName(name) {
  if (!state.identity) return;
  const clean = normName(name || "");
  if (!clean) return;
  state.identity.name = clean;
  persistSession();
  state.lastName = clean;
  localStorage.setItem(STORAGE_LAST_NAME, clean);
}

function openProfileModal() {
  if (!state.identity || !el.profileModal) return;
  const profile = state.profilesByPubkey.get(state.identity.pubkey);
  if (el.profileNameInput) el.profileNameInput.value = state.identity.name || profile?.name || "";
  if (el.profileSocialInput) el.profileSocialInput.value = profile?.social || "";
  if (el.profileBioInput) el.profileBioInput.value = profile?.bio || "";
  openModal(el.profileModal);
}

function openUserModal(pubkey, fallbackName, row) {
  if (!el.userModal) return;
  const cleanPubkey = normPk(pubkey);
  const profile = state.profilesByPubkey.get(cleanPubkey);
  const name = normName(profile?.name || state.nameByPubkey.get(cleanPubkey) || fallbackName || shortPk(pubkey));
  const social = cleanSocial(profile?.social || "");
  const bio = cleanBio(profile?.bio || "");

  state.userModalContext = {
    pubkey: cleanPubkey,
    name,
    entry_id: cleanEntryId(row?.entry_id || ""),
    entry_title: cleanText(row?.title || "", 120),
    entry_artist: cleanText(row?.artist || "", 120),
  };

  if (el.userModalName) {
    el.userModalName.textContent = `@${name}`;
  }
  if (el.userModalSocial) {
    const href = socialToHref(social);
    if (href) {
      el.userModalSocial.classList.remove("hidden");
      el.userModalSocial.href = href;
      el.userModalSocial.textContent = social;
    } else {
      el.userModalSocial.classList.add("hidden");
      el.userModalSocial.href = "#";
      el.userModalSocial.textContent = "";
    }
  }
  if (el.userModalBio) {
    el.userModalBio.textContent = bio || "no bio";
  }
  renderUserModalModeration();
  openModal(el.userModal);
}

function refreshUserModalContext() {
  const ctx = state.userModalContext;
  if (!ctx?.entry_id) return;
  const row = buildRows().find((r) => r.entry_id === ctx.entry_id);
  if (!row) return;
  ctx.entry_title = cleanText(row.title || "", 120);
  ctx.entry_artist = cleanText(row.artist || "", 120);
  ctx.pubkey = isHex64(normPk(row.owner_pubkey || "")) ? normPk(row.owner_pubkey) : ctx.pubkey;
}

function renderUserModalModeration() {
  const ctx = state.userModalContext;
  const entryId = cleanEntryId(ctx?.entry_id || "");
  const hasEntry = Boolean(entryId);

  if (el.userModalEntryMeta) {
    if (hasEntry) {
      const title = cleanText(ctx?.entry_title || "", 120) || "song";
      const artist = cleanText(ctx?.entry_artist || "", 120) || "unknown";
      el.userModalEntryMeta.textContent = `${title} · ${artist}`;
      el.userModalEntryMeta.classList.remove("hidden");
    } else {
      el.userModalEntryMeta.textContent = "";
      el.userModalEntryMeta.classList.add("hidden");
    }
  }

  const canAdminModerateUser = Boolean(
    state.identity
      && isAdminMe()
      && isHex64(normPk(ctx?.pubkey || "")),
  );
  if (el.userModalAdminBlock) {
    el.userModalAdminBlock.classList.toggle("hidden", !canAdminModerateUser);
  }
  if (!canAdminModerateUser) return;

  const ban = activeBanForPubkey(ctx.pubkey);
  if (el.userModalBanState) {
    if (!ban) {
      el.userModalBanState.textContent = "active";
    } else if (ban.until_ts) {
      el.userModalBanState.textContent = `temp banned until ${fmtDate(ban.until_ts)}`;
    } else {
      el.userModalBanState.textContent = "banned";
    }
  }
}

function openModal(node) {
  if (!node) return;
  node.classList.remove("hidden");
}

function closeModal(node) {
  if (!node) return;
  node.classList.add("hidden");
  if (node === el.userModal) {
    state.userModalContext = null;
  }
  if (node === el.deleteConfirmModal) {
    state.deleteConfirmContext = null;
  }
}
