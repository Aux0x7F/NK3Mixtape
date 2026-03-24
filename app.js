const eventTools = window.EventTools || window[["No", "strTools"].join("")];
const compatFailure = detectCriticalCompatFailure(eventTools);
const { SimplePool, finalizeEvent, getPublicKey, verifyEvent } = compatFailure
  ? {
      SimplePool: class SimplePoolFallback {},
      finalizeEvent: null,
      getPublicKey: null,
      verifyEvent: null,
    }
  : eventTools;

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

const SONG_TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "audio",
  "clean",
  "edit",
  "explicit",
  "feat",
  "featuring",
  "ft",
  "hd",
  "hq",
  "live",
  "lyric",
  "lyrics",
  "mix",
  "official",
  "remix",
  "the",
  "version",
  "video",
  "visualizer",
  "with",
]);

const SONG_ARTIST_STOP_WORDS = new Set([
  "a",
  "and",
  "feat",
  "featuring",
  "ft",
  "the",
  "vs",
  "with",
  "x",
]);

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
const LIST_MODE_CYCLE = ["ranked", "recent", "shuffle"];
const LIST_MODE_LABELS = {
  ranked: "Ranked",
  recent: "Recent",
  shuffle: "Shuffle",
};
const LIST_MODE_HOLD_MS = 550;
const REPO_URL = "https://github.com/Aux0x7F/NK3Mixtape";
const SWIPE_TRIGGER_RATIO = 0.2;
const MINI_BACKGROUND_HOLD_MS = 520;
const MINI_MARQUEE_DELAY_MS = 2000;
const MINI_MARQUEE_PX_PER_SEC = 30;

const pool = compatFailure ? null : new SimplePool();

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
  entryOwners: new Map(),
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
  modal: {
    lastFocused: null,
  },
  ui: {
    appReady: false,
    appReadySeq: 0,
    fontsReadyPromise: null,
  },
  list: {
    mode: "ranked",
    shuffleOrder: [],
    modeHoldTimer: 0,
    modeHoldTriggered: false,
    openEntryMenuId: "",
  },
  youtube: {
    apiPromise: null,
    playerPromise: null,
    player: null,
    currentEntryId: "",
    currentVideoId: "",
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    seeking: false,
    progressTimer: 0,
    ad: {
      active: false,
      pending: false,
      muted: false,
      retrySeq: 0,
      lastTargetVideoId: "",
      watchTimer: 0,
    },
    queue: {
      mode: "ranked",
      entryIds: [],
      index: -1,
      capturedAt: 0,
      shuffleSeedIds: [],
    },
  },
  userModalContext: null,
  deleteConfirmContext: null,
  editContext: null,
};

let renderQueued = false;
let liveSub = null;
let liveSeq = 0;
let liveReconnectTimer = 0;
let liveReconnectAttempt = 0;
let swReg = null;
let updateToastNode = null;
let lastAdminVisibilityDiagKey = "";
let miniMarqueeRefreshFrame = 0;
const miniMarqueeTimers = new WeakMap();

const el = {
  appMain: document.getElementById("appMain"),
  appBootOverlay: document.getElementById("appBootOverlay"),
  authSplash: document.getElementById("authSplash"),
  compatGate: document.getElementById("compatGate"),
  compatReason: document.getElementById("compatReason"),
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
  listModeBtn: document.getElementById("listModeBtn"),
  openAddSongBtn: document.getElementById("openAddSongBtn"),
  cancelAddSongBtn: document.getElementById("cancelAddSongBtn"),
  addSongModal: document.getElementById("addSongModal"),
  editSongModal: document.getElementById("editSongModal"),
  editEntryForm: document.getElementById("editEntryForm"),
  editTitleInput: document.getElementById("editTitleInput"),
  editArtistInput: document.getElementById("editArtistInput"),
  editYoutubeInput: document.getElementById("editYoutubeInput"),
  cancelEditSongBtn: document.getElementById("cancelEditSongBtn"),
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
  openInfoBtn: document.getElementById("openInfoBtn"),
  menuInstallBtn: document.getElementById("menuInstallBtn"),
  menuLogoutBtn: document.getElementById("menuLogoutBtn"),
  infoModal: document.getElementById("infoModal"),
  infoRepoLink: document.getElementById("infoRepoLink"),
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
  miniPlayer: document.getElementById("miniPlayer"),
  miniPlayerShell: document.getElementById("miniPlayerShell"),
  miniThumbImage: document.getElementById("miniThumbImage"),
  miniPlayerTitle: document.getElementById("miniPlayerTitle"),
  miniPlayerArtist: document.getElementById("miniPlayerArtist"),
  miniPrevPreview: document.getElementById("miniPrevPreview"),
  miniPrevPreviewIcon: document.getElementById("miniPrevPreviewIcon"),
  miniPrevPreviewThumb: document.getElementById("miniPrevPreviewThumb"),
  miniPrevPreviewTitle: document.getElementById("miniPrevPreviewTitle"),
  miniPrevPreviewArtist: document.getElementById("miniPrevPreviewArtist"),
  miniNextPreview: document.getElementById("miniNextPreview"),
  miniNextPreviewIcon: document.getElementById("miniNextPreviewIcon"),
  miniNextPreviewThumb: document.getElementById("miniNextPreviewThumb"),
  miniNextPreviewTitle: document.getElementById("miniNextPreviewTitle"),
  miniNextPreviewArtist: document.getElementById("miniNextPreviewArtist"),
  miniPrevBtn: document.getElementById("miniPrevBtn"),
  miniPlayPauseBtn: document.getElementById("miniPlayPauseBtn"),
  miniNextBtn: document.getElementById("miniNextBtn"),
  miniProgress: document.getElementById("miniProgress"),
  miniElapsed: document.getElementById("miniElapsed"),
  miniDuration: document.getElementById("miniDuration"),
  toastStack: document.getElementById("toastStack"),
};

if (compatFailure) {
  showCompatibilityGate(compatFailure);
} else {
  void init();
}

function detectCriticalCompatFailure(eventToolsRef) {
  const checks = [
    ["modern JavaScript support", typeof Promise === "function" && typeof Map === "function" && typeof Set === "function"],
    ["required DOM APIs", typeof document?.querySelector === "function" && typeof window?.requestAnimationFrame === "function"],
    ["fetch", typeof window?.fetch === "function"],
    ["URLSearchParams", typeof window?.URLSearchParams === "function"],
    ["TextEncoder", typeof window?.TextEncoder === "function"],
    ["local storage", storageAvailable()],
    ["Web Crypto", Boolean(window?.crypto?.subtle) && typeof window?.crypto?.getRandomValues === "function"],
    ["event tools bundle", Boolean(eventToolsRef && typeof eventToolsRef.SimplePool === "function" && typeof eventToolsRef.finalizeEvent === "function" && typeof eventToolsRef.getPublicKey === "function" && typeof eventToolsRef.verifyEvent === "function")],
  ];
  const failed = checks.find(([, ok]) => !ok);
  return failed ? `${failed[0]} unavailable` : "";
}

function storageAvailable() {
  try {
    const key = "__nk3_storage_test__";
    window.localStorage?.setItem(key, "1");
    window.localStorage?.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

function showCompatibilityGate(reason = "") {
  document.body.classList.add("compat-blocked");
  el.authSplash?.classList.add("hidden");
  el.appMain?.classList.add("hidden");
  el.miniPlayer?.classList.add("hidden");
  el.compatGate?.classList.remove("hidden");
  el.compatGate?.classList.add("compat-gate-visible");
  if (el.compatReason) {
    el.compatReason.textContent = reason ? `Missing: ${reason}.` : "";
    el.compatReason.classList.toggle("hidden", !reason);
  }
}

function init() {
  registerServiceWorker();
  bind();
  if (el.infoRepoLink) {
    el.infoRepoLink.href = REPO_URL;
    el.infoRepoLink.textContent = REPO_URL;
  }
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
  window.addEventListener("resize", scheduleMiniMarqueeSync);
  if (el.signinForm) {
    el.signinForm.addEventListener("submit", onSigninSubmit);
  }
  if (el.openAddSongBtn) {
    el.openAddSongBtn.addEventListener("click", () => {
      if (!state.identity) return;
      closeEntryOverflow();
      openModal(el.addSongModal);
      el.titleInput?.focus();
    });
  }
  if (el.listModeBtn) {
    el.listModeBtn.addEventListener("click", (event) => {
      if (state.list.modeHoldTriggered) {
        state.list.modeHoldTriggered = false;
        event.preventDefault();
        return;
      }
      cycleListMode();
    });
    el.listModeBtn.addEventListener("pointerdown", onListModePointerDown);
    el.listModeBtn.addEventListener("pointerup", clearListModeHold);
    el.listModeBtn.addEventListener("pointercancel", clearListModeHold);
    el.listModeBtn.addEventListener("pointerleave", clearListModeHold);
  }
  if (el.cancelAddSongBtn) {
    el.cancelAddSongBtn.addEventListener("click", () => {
      closeModal(el.addSongModal);
    });
  }
  if (el.cancelEditSongBtn) {
    el.cancelEditSongBtn.addEventListener("click", () => {
      closeModal(el.editSongModal);
    });
  }
  if (el.splashInstallBtn) {
    el.splashInstallBtn.addEventListener("click", () => void onInstallClick());
  }
  if (el.menuInstallBtn) {
    el.menuInstallBtn.addEventListener("click", () => void onInstallClick());
  }
  el.entryForm.addEventListener("submit", onEntrySubmit);
  if (el.editEntryForm) {
    el.editEntryForm.addEventListener("submit", (event) => {
      void onEditEntrySubmit(event);
    });
  }
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
      closeModal(el.menuModal, { restoreFocus: false });
      openProfileModal();
    });
  }
  if (el.openAdminBtn) {
    el.openAdminBtn.addEventListener("click", () => {
      closeModal(el.menuModal, { restoreFocus: false });
      openModal(el.adminModal);
    });
  }
  if (el.openInfoBtn) {
    el.openInfoBtn.addEventListener("click", () => {
      closeModal(el.menuModal, { restoreFocus: false });
      openModal(el.infoModal);
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
  if (el.miniPlayPauseBtn) {
    el.miniPlayPauseBtn.addEventListener("click", () => void onMiniPlayPause());
  }
  if (el.miniPrevBtn) {
    el.miniPrevBtn.addEventListener("click", () => void onMiniPrev());
  }
  if (el.miniNextBtn) {
    el.miniNextBtn.addEventListener("click", () => void onMiniNext());
  }
  if (el.miniProgress) {
    el.miniProgress.addEventListener("input", onMiniSeekInput);
    el.miniProgress.addEventListener("change", () => void onMiniSeekCommit());
    el.miniProgress.addEventListener("pointerdown", () => {
      state.youtube.seeking = true;
    });
    el.miniProgress.addEventListener("blur", () => {
      state.youtube.seeking = false;
    });
  }
  if (el.miniPlayer) {
    bindMiniPlayerBackgroundLongPress(el.miniPlayer);
    bindMiniPlayerSwipe(el.miniPlayer);
  }

  document.querySelectorAll("[data-close-modal]").forEach((node) => {
    node.addEventListener("click", () => {
      const id = node.getAttribute("data-close-modal");
      closeModal(document.getElementById(id));
    });
  });
  [el.menuModal, el.adminModal, el.infoModal, el.profileModal, el.userModal, el.addSongModal, el.editSongModal, el.deleteConfirmModal].forEach((modal) => {
    if (!modal) return;
    modal.addEventListener("click", (event) => {
      if (event.target === modal) closeModal(modal);
    });
  });
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".item-overflow")) {
      closeEntryOverflow();
    }
  });
  document.addEventListener("keydown", onGlobalPlaybackKeydown);
}

function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  void navigator.serviceWorker.register("./sw.js").then((registration) => {
    swReg = registration;
    if (registration.waiting) {
      notifyAppUpdate(registration);
    }
    registration.addEventListener("updatefound", () => {
      const installing = registration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && navigator.serviceWorker.controller) {
          notifyAppUpdate(registration);
        }
      });
    });
  }).catch((err) => {
    console.error(err);
  });

  navigator.serviceWorker.addEventListener("controllerchange", () => {
    dismissActionToast(updateToastNode);
    updateToastNode = null;
    if (!window.__nk3SwReloading) {
      window.__nk3SwReloading = true;
      window.location.reload();
    }
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
    if (state.identity) requestAppBootRelease();
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
    state.ui.appReady = false;
    state.ui.appReadySeq += 1;
    if (el.openAddSongBtn) el.openAddSongBtn.classList.add("hidden");
    if (el.listModeBtn) el.listModeBtn.classList.add("hidden");
    if (state.lastName && el.nameInput) el.nameInput.value = state.lastName;
    if (el.passphraseInput) el.passphraseInput.value = "";
    closeModal(el.menuModal);
    closeModal(el.adminModal);
    closeModal(el.infoModal);
    closeModal(el.profileModal);
    closeModal(el.userModal);
    closeModal(el.addSongModal);
    closeModal(el.editSongModal);
    closeModal(el.deleteConfirmModal);
    state.userModalContext = null;
    state.deleteConfirmContext = null;
    state.editContext = null;
    state.list.openEntryMenuId = "";
    if (el.menuIdentity) el.menuIdentity.textContent = "";
    el.identityContainer.replaceChildren();
  }
  syncAppBootUi();
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
  renderListControls();
  if (el.openAdminBtn) {
    const canOpenAdmin = isAdminMe() || !hasAdmin();
    el.openAdminBtn.classList.toggle("hidden", !canOpenAdmin);
    maybeLogAdminVisibility(canOpenAdmin);
  }
  const locked = Boolean(activeBanForPubkey(state.identity.pubkey));
  for (const control of el.entryForm.querySelectorAll("input,button")) {
    control.disabled = locked;
  }
  if (el.editEntryForm) {
    for (const control of el.editEntryForm.querySelectorAll("input,button")) {
      control.disabled = locked;
    }
  }
  if (!isAdminMe()) {
    state.showRevoked = false;
    el.showRevokedToggle.checked = false;
    closeModal(el.adminModal);
  }
}

function renderListControls() {
  if (!el.listModeBtn) return;
  const signedIn = Boolean(state.identity);
  el.listModeBtn.classList.toggle("hidden", !signedIn);
  if (!signedIn) return;

  const mode = LIST_MODE_CYCLE.includes(state.list.mode) ? state.list.mode : "ranked";
  const label = LIST_MODE_LABELS[mode] || LIST_MODE_LABELS.ranked;
  const hint = mode === "shuffle" ? "shuffle mode; hold to reshuffle" : `${label.toLowerCase()} mode`;
  el.listModeBtn.classList.toggle("is-shuffle", mode === "shuffle");
  el.listModeBtn.dataset.mode = mode;
  el.listModeBtn.setAttribute("aria-label", hint);
  el.listModeBtn.title = hint;
  el.listModeBtn.replaceChildren(createListModeButtonContent(mode, label));
}

function maybeLogAdminVisibility(canOpenAdmin) {
  if (!state.identity || canOpenAdmin || !state.synced || !hasAdmin()) return;
  const isMember = state.admins.has(state.identity.pubkey);
  const payload = {
    current_user_pubkey: state.identity.pubkey,
    root_admin_pubkey: state.admin.pubkey,
    admin_set_membership: isMember,
    synced: state.synced,
  };
  const key = JSON.stringify(payload);
  if (key === lastAdminVisibilityDiagKey) return;
  lastAdminVisibilityDiagKey = key;
  console.info("[nk3] admin hidden after sync", payload);
}

function isTouchLikeDevice() {
  return Boolean(window.matchMedia?.("(pointer: coarse)")?.matches || navigator.maxTouchPoints > 0);
}

function shouldIgnorePlaybackKeyTarget(target) {
  if (!(target instanceof Element)) return false;
  if (target.closest("input, textarea, select, button, a, [contenteditable='true'], [contenteditable=''], [role='textbox']")) return true;
  return false;
}

function onGlobalPlaybackKeydown(event) {
  if (!state.identity) return;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.code === "Space" || event.key === " ") {
    event.preventDefault();
    void onMiniPlayPause();
    return;
  }
  if (shouldIgnorePlaybackKeyTarget(event.target)) return;
  if (event.key === "ArrowLeft") {
    event.preventDefault();
    void onMiniPrev();
    return;
  }
  if (event.key === "ArrowRight") {
    event.preventDefault();
    void onMiniNext();
  }
}

function triggerHapticPulse() {
  try {
    if (typeof navigator?.vibrate === "function") {
      navigator.vibrate(14);
    }
  } catch {
    // ignore haptic failures
  }
}

function swipeTriggerDistance(width) {
  const baseWidth = Math.max(1, Number(width) || 0);
  return Math.max(1, baseWidth * SWIPE_TRIGGER_RATIO);
}

function cycleListMode() {
  if (!state.identity) return;
  clearListModeHold();
  closeEntryOverflow(false);
  const currentIndex = Math.max(0, LIST_MODE_CYCLE.indexOf(state.list.mode));
  state.list.mode = LIST_MODE_CYCLE[(currentIndex + 1) % LIST_MODE_CYCLE.length];
  renderList();
}

function onListModePointerDown(event) {
  if (state.list.mode !== "shuffle") return;
  if ("button" in event && Number(event.button) !== 0) return;
  clearListModeHold();
  state.list.modeHoldTriggered = false;
  state.list.modeHoldTimer = window.setTimeout(() => {
    state.list.modeHoldTriggered = true;
    reshuffleVisibleList();
  }, LIST_MODE_HOLD_MS);
}

function clearListModeHold() {
  if (state.list.modeHoldTimer) {
    clearTimeout(state.list.modeHoldTimer);
    state.list.modeHoldTimer = 0;
  }
}

function reshuffleVisibleList() {
  const rows = buildBaseRows();
  state.list.shuffleOrder = shuffleIds(rows.map((row) => row.entry_id));
  closeEntryOverflow(false);
  renderList();
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
  state.ui.appReady = false;
  state.ui.appReadySeq += 1;
  rememberName(pubkey, name, nowSec());
  persistSession();
  void ensureNameClaimForCurrentUser(name);
  renderIdentity();
  renderWizard();
  renderList();
  setStatus(`signed in @${name}`);
}

function onLogout() {
  stopYouTubeProgressTicker();
  try {
    state.youtube.player?.pauseVideo?.();
  } catch {
    // ignore pause failures during logout
  }
  state.youtube.ad.retrySeq += 1;
  clearHeuristicAdState({ unmute: true });
  state.youtube.isPlaying = false;
  state.youtube.currentEntryId = "";
  state.youtube.currentVideoId = "";
  state.youtube.currentTime = 0;
  state.youtube.duration = 0;
  state.youtube.seeking = false;
  resetPlaybackQueue();
  clearListModeHold();
  state.list.mode = "ranked";
  state.list.shuffleOrder = [];
  state.list.openEntryMenuId = "";
  state.identity = null;
  state.ui.appReady = false;
  state.ui.appReadySeq += 1;
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
  window.addEventListener("online", () => {
    scheduleLiveReconnect(300, "online");
  });
  window.addEventListener("offline", () => {
    setStatus("offline");
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && !liveSub) {
      scheduleLiveReconnect(200, "visible");
    }
  });
  startLiveSync("init");
}

function startLiveSync(reason) {
  if (liveReconnectTimer) {
    clearTimeout(liveReconnectTimer);
    liveReconnectTimer = 0;
  }
  const seq = ++liveSeq;
  if (liveSub && typeof liveSub.close === "function") {
    const stale = liveSub;
    liveSub = null;
    Promise.resolve(stale.close(`restart:${reason}`)).catch(() => {});
  }

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
  state.synced = false;
  setStatus(`syncing ${APP.relays.length} relays...`);
  liveSub = pool.subscribeMany(APP.relays, filter, {
    onevent: (ev) => {
      if (seq !== liveSeq) return;
      if (ingestEvent(ev)) queueRender();
    },
    oneose: () => {
      if (seq !== liveSeq) return;
      liveReconnectAttempt = 0;
      state.synced = true;
      setStatus(`synced ${state.seen.size} events${hasAdmin() ? ` admin ${shortPk(state.admin.pubkey)}` : " no admin"}`);
      renderIdentity();
      renderWizard();
      renderList();
    },
    onclose: (reasons) => {
      if (seq !== liveSeq) return;
      liveSub = null;
      state.synced = false;
      const closed = reasons.filter(Boolean).length;
      const delay = nextLiveReconnectDelayMs();
      if (closed > 0) {
        setStatus(`relay close ${closed}/${APP.relays.length}; reconnecting in ${Math.ceil(delay / 1000)}s`);
      }
      scheduleLiveReconnect(delay, "close");
    },
  });
}

function nextLiveReconnectDelayMs() {
  const exp = Math.min(liveReconnectAttempt, 6);
  const base = 1000 * (2 ** exp);
  liveReconnectAttempt += 1;
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(20000, base + jitter);
}

function scheduleLiveReconnect(delayMs, reason) {
  const delay = Math.max(150, Number(delayMs) || 0);
  if (liveReconnectTimer) clearTimeout(liveReconnectTimer);
  liveReconnectTimer = window.setTimeout(() => {
    liveReconnectTimer = 0;
    startLiveSync(reason || "retry");
  }, delay);
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
  const signer = normPk(ev.pubkey);
  const created_at = unixOr(p.created_at, ev.created_at);
  if (!entry_id || !title || !artist) return false;
  if (user) rememberName(signer, user, ev.created_at);

  const claimedOwner = normPk(p.owner_pubkey || firstTag(ev, "p"));
  const ownerCandidate = isHex64(claimedOwner) ? claimedOwner : signer;
  const ownerNameCandidate = normName(p.owner_name || "") || user || resolveName(ownerCandidate);
  const owner = rememberEntryOwner(entry_id, ownerCandidate, ownerNameCandidate, created_at, ev.id);
  const owner_pubkey = owner?.pubkey || ownerCandidate;
  const owner_name = owner?.user || user || resolveName(owner_pubkey);

  const cur = state.entries.get(entry_id);
  if (cur && (cur.event_created_at > ev.created_at || (cur.event_created_at === ev.created_at && (cur.event_id || "") >= ev.id))) {
    if (cur.pubkey === owner_pubkey && cur.user === owner_name) return false;
    state.entries.set(entry_id, { ...cur, pubkey: owner_pubkey, user: owner_name });
    return true;
  }
  state.entries.set(entry_id, {
    entry_id,
    title,
    artist,
    youtube_id,
    youtube_url,
    user: owner_name,
    created_at,
    pubkey: owner_pubkey,
    event_created_at: ev.created_at,
    event_id: ev.id,
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
  for (const e of dedupe.values()) {
    entries.push(e);
    if (isHex64(normPk(e.pubkey || ""))) {
      rememberEntryOwner(e.entry_id, normPk(e.pubkey), normName(e.user || ""), e.created_at, ev.id);
    }
  }
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
  renderListControls();
  el.list.replaceChildren();
  if (!state.identity) {
    renderMiniPlayer();
    syncAppBootUi();
    return;
  }
  const rows = buildRows();
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "drop the first track";
    el.list.appendChild(empty);
    renderMiniPlayer();
    requestAppBootRelease();
    return;
  }
  for (const row of rows) el.list.appendChild(renderRow(row));
  syncCurrentPlaybackRowUi();
  renderMiniPlayer();
  requestAppBootRelease();
}

function syncAppBootUi() {
  const booting = Boolean(state.identity && !state.ui.appReady);
  el.appMain?.classList.toggle("booting", booting);
  el.appBootOverlay?.classList.toggle("hidden", !booting);
}

function shouldHoldAppBoot() {
  if (!state.identity) return false;
  if (state.sharedCache.hydrating) return true;
  const hasVisibleRows = Number(el.list?.childElementCount || 0) > 0;
  return !hasVisibleRows && !state.synced;
}

function waitForFontsReady() {
  if (!document.fonts?.ready) return Promise.resolve();
  if (!state.ui.fontsReadyPromise) {
    state.ui.fontsReadyPromise = Promise.race([
      Promise.resolve(document.fonts.ready).catch(() => undefined),
      new Promise((resolve) => window.setTimeout(resolve, 1400)),
    ]).then(() => undefined);
  }
  return state.ui.fontsReadyPromise;
}

function waitForNextPaint() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function requestAppBootRelease() {
  if (!state.identity) {
    syncAppBootUi();
    return;
  }
  if (state.ui.appReady) {
    syncAppBootUi();
    return;
  }
  syncAppBootUi();
  if (shouldHoldAppBoot()) return;
  const seq = ++state.ui.appReadySeq;
  void (async () => {
    await waitForFontsReady();
    await waitForNextPaint();
    await waitForNextPaint();
    if (seq !== state.ui.appReadySeq) return;
    if (!state.identity || shouldHoldAppBoot()) return;
    state.ui.appReady = true;
    syncAppBootUi();
  })();
}

function syncCurrentPlaybackRowUi() {
  const currentEntryId = cleanEntryId(state.youtube.currentEntryId || "");
  const shouldMarkPlaying = Boolean(currentEntryId && state.youtube.isPlaying);
  el.list?.querySelectorAll(".item.item-playing").forEach((node) => {
    if (!(node instanceof HTMLElement)) return;
    if (!shouldMarkPlaying || node.dataset.entryId !== currentEntryId) {
      node.classList.remove("item-playing");
    }
  });
  if (!shouldMarkPlaying) return;
  const currentNode = document.getElementById(entryDomId(currentEntryId));
  currentNode?.classList.add("item-playing");
}

function renderPlaybackUi() {
  syncCurrentPlaybackRowUi();
  renderMiniPlayer();
}

function buildBaseRows({ includeHiddenRevoked = false } = {}) {
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
    if (revoked && !adminCanSee && !includeHiddenRevoked) continue;
    if (ownerBanned && !(adminCanSee || ownerCanSee)) continue;
    const map = state.votes.get(e.entry_id) || new Map();
    let score = 0;
    let myVote = 0;
    for (const [pk, v] of map.entries()) {
      if (activeBanForPubkey(pk)) continue;
      score += v.value;
      if (state.identity && pk === state.identity.pubkey) myVote = v.value;
    }
    out.push({
      ...e,
      owner_pubkey,
      owner_banned: ownerBanned,
      revoked,
      score,
      myVote,
    });
  }
  return out;
}

function compareRankedRows(a, b) {
  return b.score !== a.score ? b.score - a.score : a.created_at !== b.created_at ? a.created_at - b.created_at : a.title.localeCompare(b.title);
}

function compareRecentRows(a, b) {
  return b.created_at !== a.created_at ? b.created_at - a.created_at : b.score !== a.score ? b.score - a.score : a.title.localeCompare(b.title);
}

function shuffleIds(ids, avoidFirstId = "") {
  const out = ids.filter((id) => cleanEntryId(id));
  for (let index = out.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [out[index], out[swapIndex]] = [out[swapIndex], out[index]];
  }
  const blockedId = cleanEntryId(avoidFirstId || "");
  if (blockedId && out.length > 1 && out[0] === blockedId) {
    const swapIndex = 1 + Math.floor(Math.random() * (out.length - 1));
    [out[0], out[swapIndex]] = [out[swapIndex], out[0]];
  }
  return out;
}

function reconcileShuffleOrder(rows) {
  const visibleIds = rows.map((row) => row.entry_id);
  const visibleSet = new Set(visibleIds);
  state.list.shuffleOrder = state.list.shuffleOrder.filter((id) => visibleSet.has(id));
  const have = new Set(state.list.shuffleOrder);
  const missing = visibleIds.filter((id) => !have.has(id));
  if (missing.length > 0) {
    state.list.shuffleOrder.push(...shuffleIds(missing));
  }
}

function rowsForMode(rows, mode) {
  const cleanMode = LIST_MODE_CYCLE.includes(mode) ? mode : "ranked";
  const out = [...rows];
  if (cleanMode === "recent") {
    out.sort(compareRecentRows);
    return out;
  }
  if (cleanMode === "shuffle") {
    reconcileShuffleOrder(out);
    const byId = new Map(out.map((row) => [row.entry_id, row]));
    return state.list.shuffleOrder.map((id) => byId.get(id)).filter(Boolean);
  }
  out.sort(compareRankedRows);
  return out;
}

function buildRows({ includeHiddenRevoked = false, mode = state.list.mode } = {}) {
  return rowsForMode(buildBaseRows({ includeHiddenRevoked }), mode);
}

function renderRow(r) {
  const item = document.createElement("article");
  const isCurrentPlaying = state.youtube.currentEntryId === r.entry_id && state.youtube.isPlaying;
  const canRowPlay = Boolean(r.youtube_id && !r.revoked && !r.owner_banned);
  item.className = r.revoked ? "item revoked" : "item";
  item.id = entryDomId(r.entry_id);
  item.dataset.entryId = r.entry_id;
  if (canRowPlay) item.classList.add("item-clickable");
  if (isCurrentPlaying) item.classList.add("item-playing");

  const main = document.createElement("div");
  main.className = "item-main";
  const copy = document.createElement("div");
  copy.className = "item-copy";
  const shell = document.createElement("div");
  shell.className = "item-shell";
  item.appendChild(renderItemSwipeUnderlay());
  const titleLine = document.createElement("div");
  titleLine.className = "title-line";
  const artistLine = document.createElement("div");
  artistLine.className = "artist-line";
  const metaLine = document.createElement("div");
  metaLine.className = "meta-line";

  const songUrl = cleanText(r.youtube_url || (r.youtube_id ? canonicalYouTubeUrl(r.youtube_id) : ""), 300);
  const title = songUrl ? document.createElement("a") : document.createElement("span");
  title.className = songUrl ? "title title-link" : "title";
  title.textContent = r.title;
  if (songUrl) {
    title.href = songUrl;
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEntryOverflow();
    });
  }
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
    author.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEntryOverflow();
      openUserModal(r.owner_pubkey, resolvedName, r);
    });
  } else {
    author.disabled = true;
  }

  titleLine.append(title);
  artistLine.appendChild(artist);
  metaLine.append(author);
  if (r.revoked) {
    const deleted = document.createElement("span");
    deleted.className = "item-state deleted";
    deleted.textContent = "deleted";
    metaLine.append(deleted);
  }
  copy.append(titleLine, artistLine, metaLine);
  main.append(copy);

  if (songUrl && r.youtube_id) {
    const thumbLink = document.createElement("a");
    thumbLink.className = "item-thumb";
    thumbLink.href = songUrl;
    thumbLink.target = "_blank";
    thumbLink.rel = "noopener noreferrer";
    thumbLink.setAttribute("aria-label", `${r.title} on YouTube`);
    thumbLink.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEntryOverflow();
    });
    const thumbImg = document.createElement("img");
    thumbImg.src = `https://i.ytimg.com/vi/${r.youtube_id}/hqdefault.jpg`;
    thumbImg.alt = "";
    thumbImg.loading = "lazy";
    thumbLink.appendChild(thumbImg);
    shell.appendChild(thumbLink);
  } else {
    item.classList.add("item-no-thumb");
  }

  const canEdit = Boolean(state.identity && canPubkeyModerateEntry(state.identity.pubkey, r.entry_id));
  const canDelete = Boolean(isAdminMe() && !r.revoked);
  const controls = document.createElement("div");
  controls.className = "item-controls";
  if (canEdit || canDelete) controls.appendChild(renderEntryOverflow(r, { canEdit, canDelete }));

  const vs = document.createElement("div");
  vs.className = "vote-stack";
  const vb = document.createElement("div");
  vb.className = "vote-buttons";

  const up = document.createElement("button");
  up.type = "button";
  up.className = r.myVote > 0 ? "vote up active" : "vote up";
  up.setAttribute("aria-label", "upvote");
  up.appendChild(createVoteIcon("up"));
  up.disabled = !state.identity || Boolean(activeBanForPubkey(state.identity?.pubkey || ""));
  up.addEventListener("click", (event) => {
    event.stopPropagation();
    closeEntryOverflow(false);
    void castVote(r.entry_id, 1);
  });

  const down = document.createElement("button");
  down.type = "button";
  down.className = r.myVote < 0 ? "vote down active" : "vote down";
  down.setAttribute("aria-label", "downvote");
  down.appendChild(createVoteIcon("down"));
  down.disabled = !state.identity || Boolean(activeBanForPubkey(state.identity?.pubkey || ""));
  down.addEventListener("click", (event) => {
    event.stopPropagation();
    closeEntryOverflow(false);
    void castVote(r.entry_id, -1);
  });

  vb.append(up, down);
  const score = document.createElement("div");
  score.className = "score";
  score.textContent = String(r.score);
  vs.append(vb, score);
  controls.append(vs);

  if (canRowPlay) {
    item.addEventListener("click", () => {
      if (state.youtube.currentEntryId === r.entry_id && state.youtube.isPlaying) return;
      void onRowPlay(r);
    });
  }
  bindItemSwipeVote(item, r);

  shell.append(main, controls);
  item.append(shell);
  return item;
}

function renderItemSwipeUnderlay() {
  const underlay = document.createElement("div");
  underlay.className = "item-swipe-underlay";

  const upvoteZone = document.createElement("div");
  upvoteZone.className = "item-swipe-zone item-swipe-upvote";
  const upvoteIcon = document.createElement("div");
  upvoteIcon.className = "item-swipe-icon";
  upvoteIcon.appendChild(createVoteIcon("up"));
  upvoteZone.appendChild(upvoteIcon);

  const downvoteZone = document.createElement("div");
  downvoteZone.className = "item-swipe-zone item-swipe-downvote";
  const downvoteIcon = document.createElement("div");
  downvoteIcon.className = "item-swipe-icon";
  downvoteIcon.appendChild(createVoteIcon("down"));
  downvoteZone.appendChild(downvoteIcon);

  underlay.append(upvoteZone, downvoteZone);
  return underlay;
}

function setItemSwipeVisual(node, shiftPx = 0, direction = 0, armed = false) {
  const width = Math.max(1, node.clientWidth || 1);
  const threshold = swipeTriggerDistance(width);
  const progress = Math.min(Math.abs(shiftPx) / threshold, 1);
  node.style.setProperty("--swipe-shift", `${shiftPx}px`);
  node.style.setProperty("--swipe-right-progress", direction > 0 ? String(progress) : "0");
  node.style.setProperty("--swipe-left-progress", direction < 0 ? String(progress) : "0");
  node.classList.toggle("swiping", Math.abs(shiftPx) > 0.5);
  node.classList.toggle("swipe-right", direction > 0 && Math.abs(shiftPx) > 0.5);
  node.classList.toggle("swipe-left", direction < 0 && Math.abs(shiftPx) > 0.5);
  node.classList.toggle("swipe-armed", armed);
}

function bindItemSwipeVote(node, row) {
  if (!node || !row || !isTouchLikeDevice()) return;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let moved = false;
  let swipeHandled = false;
  let shouldSuppressClick = false;
  let thresholdBuzzed = false;

  node.addEventListener("pointerdown", (event) => {
    if (event.pointerType && event.pointerType !== "touch") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("a, button, input, textarea, select, label")) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    moved = false;
    swipeHandled = false;
    shouldSuppressClick = false;
    thresholdBuzzed = false;
    setItemSwipeVisual(node);
  });

  node.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 8 || Math.abs(dy) > 8) moved = true;
    if (Math.abs(dx) <= Math.abs(dy) * 1.1) {
      setItemSwipeVisual(node);
      return;
    }
    shouldSuppressClick = true;
    const direction = dx > 0 ? 1 : -1;
    if ((direction > 0 && row.myVote > 0) || (direction < 0 && row.myVote < 0)) {
      setItemSwipeVisual(node);
      return;
    }
    const threshold = swipeTriggerDistance(node.clientWidth);
    const shift = Math.max(-threshold, Math.min(threshold, dx));
    const armed = Math.abs(shift) >= threshold - 0.5;
    if (armed && !thresholdBuzzed) {
      thresholdBuzzed = true;
      triggerHapticPulse();
    } else if (!armed) {
      thresholdBuzzed = false;
    }
    setItemSwipeVisual(node, shift, direction, armed);
  });

  node.addEventListener("pointerup", (event) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    setItemSwipeVisual(node);
    if (!moved || Math.abs(dx) < Math.abs(dy) * 1.2) return;
    const nextVote = dx > 0 ? 1 : -1;
    if (row.myVote === nextVote) return;
    const threshold = swipeTriggerDistance(node.clientWidth);
    if (Math.abs(dx) < threshold) return;
    swipeHandled = true;
    node.dataset.swipeJustVoted = "1";
    window.setTimeout(() => {
      if (node.dataset.swipeJustVoted === "1") delete node.dataset.swipeJustVoted;
    }, 220);
    void castVote(row.entry_id, nextVote);
  });

  node.addEventListener("pointercancel", () => {
    pointerId = null;
    moved = false;
    swipeHandled = false;
    shouldSuppressClick = false;
    thresholdBuzzed = false;
    setItemSwipeVisual(node);
  });

  node.addEventListener("click", (event) => {
    if (swipeHandled || shouldSuppressClick || node.dataset.swipeJustVoted === "1") {
      swipeHandled = false;
      shouldSuppressClick = false;
      event.preventDefault();
      event.stopPropagation();
    }
  }, true);
}

function renderEntryOverflow(row, { canEdit, canDelete }) {
  const wrap = document.createElement("div");
  wrap.className = state.list.openEntryMenuId === row.entry_id ? "item-overflow open" : "item-overflow";
  wrap.dataset.entryId = row.entry_id;

  const rail = document.createElement("div");
  rail.className = "item-action-rail";

  if (canEdit) {
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "item-action-btn item-edit-btn";
    edit.title = "edit song";
    edit.setAttribute("aria-label", "edit song");
    edit.appendChild(createEditIcon());
    edit.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEntryOverflow();
      openEditModal(row);
    });
    rail.appendChild(edit);
  }

  if (canDelete) {
    const del = document.createElement("button");
    del.type = "button";
    del.className = "item-action-btn item-delete-btn";
    del.title = "delete song";
    del.setAttribute("aria-label", "delete song");
    del.appendChild(createTrashIcon());
    del.addEventListener("click", (event) => {
      event.stopPropagation();
      closeEntryOverflow();
      openDeleteConfirm(row);
    });
    rail.appendChild(del);
  }

  const more = document.createElement("button");
  more.type = "button";
  more.className = "item-more-btn";
  more.title = wrap.classList.contains("open") ? "close actions" : "song actions";
  more.setAttribute("aria-label", wrap.classList.contains("open") ? "close song actions" : "song actions");
  more.appendChild(createMoreIcon());
  more.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleEntryOverflow(row.entry_id);
  });

  wrap.append(rail, more);
  return wrap;
}

function syncEntryOverflowUi() {
  document.querySelectorAll(".item-overflow").forEach((wrap) => {
    const entryId = cleanEntryId(wrap.getAttribute("data-entry-id") || "");
    const isOpen = Boolean(entryId) && state.list.openEntryMenuId === entryId;
    wrap.classList.toggle("open", isOpen);
    const more = wrap.querySelector(".item-more-btn");
    if (more instanceof HTMLButtonElement) {
      more.title = isOpen ? "close actions" : "song actions";
      more.setAttribute("aria-label", isOpen ? "close song actions" : "song actions");
    }
  });
}

function toggleEntryOverflow(entry_id) {
  const cleanId = cleanEntryId(entry_id || "");
  if (!cleanId) return;
  state.list.openEntryMenuId = state.list.openEntryMenuId === cleanId ? "" : cleanId;
  syncEntryOverflowUi();
}

function closeEntryOverflow(render = false) {
  if (!state.list.openEntryMenuId) return;
  state.list.openEntryMenuId = "";
  if (render) queueRender();
  else syncEntryOverflowUi();
}

function onRowPlay(row) {
  if (!row?.youtube_id) return;
  closeEntryOverflow(false);
  void onPlayToggle(row.entry_id, row.youtube_id, { captureQueue: true, toggleSame: false });
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

function createMoreIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const cy of [5, 12, 19]) {
    const circle = document.createElementNS(ns, "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", String(cy));
    circle.setAttribute("r", "1.8");
    svg.appendChild(circle);
  }
  return svg;
}

function createListModeButtonContent(mode, label) {
  const frag = document.createDocumentFragment();
  frag.appendChild(createListModeIcon(mode));
  const text = document.createElement("span");
  text.textContent = label;
  frag.appendChild(text);
  return frag;
}

function createListModeIcon(mode) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  if (mode === "recent") {
    path.setAttribute("d", "M12 4a8 8 0 1 0 7.75 10H17.6a6 6 0 1 1-1.14-5.3L14 11h6V5l-2.12 2.12A7.96 7.96 0 0 0 12 4zm-1 3h2v5.2l3 1.8-1 1.74-4-2.4V7z");
  } else if (mode === "shuffle") {
    path.setAttribute("d", "M17 3h4v4h-2V6h-2.1l-4.35 4.35-1.4-1.4L15.49 5H13V3h4zm-10 2 3.44 3.44-1.4 1.41L5.6 6.4H3V4h4zm10 10h4v4h-2v-1h-2l-4.45-4.45 1.4-1.41L17.49 16H19v-1zm-10 0 2.04 2.04-1.4 1.41L7 18H3v-2h4z");
  } else {
    path.setAttribute("d", "M5 6h14v2H5V6zm3 5h11v2H8v-2zm4 5h7v2h-7v-2z");
  }
  svg.appendChild(path);
  return svg;
}

function createEditIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 17.25V21h3.75L18.8 8.95l-3.75-3.75L3 17.25zm17.71-10.04a1 1 0 0 0 0-1.41l-2.5-2.5a1 1 0 0 0-1.41 0l-1.5 1.5 3.75 3.75 1.66-1.34z");
  svg.appendChild(path);
  return svg;
}

function createPlayPauseIcon(isPlaying) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    isPlaying
      ? "M7 5h4v14H7zM13 5h4v14h-4z"
      : "M8 5v14l11-7z",
  );
  svg.appendChild(path);
  return svg;
}

function createVoteIcon(direction) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  path.setAttribute(
    "d",
    direction === "down"
      ? "M10 16L4.5 8h11L10 16z"
      : "M10 4l5.5 8h-11L10 4z",
  );
  svg.appendChild(path);
  return svg;
}

function createMiniControlIcon(kind, isPlaying = false) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(ns, "path");
  if (kind === "prev") {
    path.setAttribute("d", "M7 6h2v12H7zM18 6v12l-8-6 8-6z");
  } else if (kind === "next") {
    path.setAttribute("d", "M15 6h2v12h-2zM6 6l8 6-8 6V6z");
  } else {
    path.setAttribute(
      "d",
      isPlaying
        ? "M7 5h4v14H7zM13 5h4v14h-4z"
        : "M8 5v14l11-7z",
    );
  }
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
  const fields = parseEntryFields(el.titleInput?.value || "", el.artistInput?.value || "", el.youtubeInput?.value || "", {
    titleEl: el.titleInput,
    artistEl: el.artistInput,
    youtubeEl: el.youtubeInput,
  });
  if (!fields) return;
  const duplicate = findDuplicateEntry(fields, { includeHiddenRevoked: true });
  if (duplicate) {
    const isDeletedMatch = duplicate.reason === "deleted_youtube" || duplicate.reason === "deleted_fuzzy";
    const scrolled = scrollToEntry(duplicate.entry_id);
    clearEntryDraft();
    if (isDeletedMatch) {
      const msg = `This song has been previously declined. ${duplicate.title} - ${duplicate.artist}`;
      showToast(msg, { kind: "warn", timeoutMs: 4200 });
      setStatus(`${msg}${scrolled ? " matched deleted entry" : ""}`);
    } else if (duplicate.reason === "youtube") {
      closeModal(el.addSongModal);
      const msg = scrolled
        ? `Song already exists. Scrolling you to it.`
        : `Song already exists.`;
      showToast(msg, { kind: "info", timeoutMs: 3200 });
      setStatus(`${msg} (${duplicate.title} - ${duplicate.artist})`);
    } else {
      closeModal(el.addSongModal);
      const msg = scrolled
        ? `Song already exists. Scrolling you to it.`
        : `Song already exists.`;
      showToast(msg, { kind: "info", timeoutMs: 3200 });
      setStatus(`${msg} (${duplicate.title} - ${duplicate.artist})`);
    }
    return;
  }

  const created_at = nowSec();
  const entry_id = `entry:${state.identity.pubkey.slice(0, 8)}:${Date.now().toString(36)}`;
  const ok = await publishEntryEvent({
    entry_id,
    title: fields.title,
    artist: fields.artist,
    youtube_id: fields.youtube_id,
    youtube_url: fields.youtube_url,
    user: state.identity.name,
    owner_pubkey: state.identity.pubkey,
    created_at,
  });
  if (ok < 0) return;
  clearEntryDraft();
  closeModal(el.addSongModal);
  renderList();
  setStatus(`published ${ok}/${APP.relays.length}`);
}

function clearEntryDraft() {
  if (el.titleInput) el.titleInput.value = "";
  if (el.artistInput) el.artistInput.value = "";
  if (el.youtubeInput) el.youtubeInput.value = "";
}

function openEditModal(row) {
  if (!state.identity) return setStatus("sign in first");
  const entry_id = cleanEntryId(row?.entry_id || "");
  if (!entry_id) return setStatus("invalid entry");
  if (!canPubkeyModerateEntry(state.identity.pubkey, entry_id)) return setStatus("not allowed");

  const owner_pubkey = normPk(row?.owner_pubkey || ownerPubkeyForEntry(entry_id));
  const owner_name = normName(
    state.entryOwners.get(entry_id)?.user
      || (owner_pubkey ? resolveName(owner_pubkey) : "")
      || row?.user
      || "",
  ) || state.identity.name;
  const created_at = unixOr(row?.created_at, nowSec());
  const youtube = cleanText(row?.youtube_url || (row?.youtube_id ? canonicalYouTubeUrl(row.youtube_id) : ""), 300);

  state.editContext = { entry_id, owner_pubkey, owner_name, created_at };
  if (el.editTitleInput) el.editTitleInput.value = cleanText(row?.title || "", 120);
  if (el.editArtistInput) el.editArtistInput.value = cleanText(row?.artist || "", 120);
  if (el.editYoutubeInput) el.editYoutubeInput.value = youtube;
  openModal(el.editSongModal);
  el.editTitleInput?.focus();
}

async function onEditEntrySubmit(event) {
  event.preventDefault();
  if (!state.identity) return setStatus("sign in first");
  const meBan = activeBanForPubkey(state.identity.pubkey);
  if (meBan) {
    return setStatus(meBan.until_ts ? `banned until ${fmtDate(meBan.until_ts)}` : "banned");
  }

  const ctx = state.editContext;
  const entry_id = cleanEntryId(ctx?.entry_id || "");
  if (!entry_id) return setStatus("select a song first");
  if (!canPubkeyModerateEntry(state.identity.pubkey, entry_id)) return setStatus("not allowed");

  const fields = parseEntryFields(el.editTitleInput?.value || "", el.editArtistInput?.value || "", el.editYoutubeInput?.value || "", {
    titleEl: el.editTitleInput,
    artistEl: el.editArtistInput,
    youtubeEl: el.editYoutubeInput,
  });
  if (!fields) return;

  const owner_pubkey = isHex64(normPk(ctx?.owner_pubkey || ""))
    ? normPk(ctx.owner_pubkey)
    : ownerPubkeyForEntry(entry_id) || state.identity.pubkey;
  const user = normName(ctx?.owner_name || (owner_pubkey ? resolveName(owner_pubkey) : state.identity.name)) || state.identity.name;
  const created_at = unixOr(ctx?.created_at, nowSec());

  const ok = await publishEntryEvent({
    entry_id,
    title: fields.title,
    artist: fields.artist,
    youtube_id: fields.youtube_id,
    youtube_url: fields.youtube_url,
    user,
    owner_pubkey,
    created_at,
  });
  if (ok < 0) return;

  closeModal(el.editSongModal);
  renderList();
  setStatus(`updated ${ok}/${APP.relays.length}`);
}

function parseEntryFields(titleRaw, artistRaw, youtubeRawInput, { titleEl, artistEl, youtubeEl } = {}) {
  const title = cleanText(titleRaw, 120);
  const artist = cleanText(artistRaw, 120);
  const youtubeRaw = cleanText(youtubeRawInput, 300);
  const youtube_id = youtubeIdFromAny(youtubeRaw);
  const youtube_url = youtube_id ? canonicalYouTubeUrl(youtube_id) : "";

  if (!title) {
    titleEl?.focus();
    setStatus("song title required");
    return null;
  }
  if (!artist) {
    artistEl?.focus();
    setStatus("artist required");
    return null;
  }
  if (youtubeRaw && !youtube_id) {
    youtubeEl?.focus();
    setStatus("invalid youtube url");
    return null;
  }

  return { title, artist, youtube_id, youtube_url };
}

function findDuplicateEntry(fields, { includeHiddenRevoked = false } = {}) {
  if (!fields || typeof fields !== "object") return null;
  const rows = buildBaseRows({ includeHiddenRevoked });
  const youtube_id = cleanYouTubeId(fields.youtube_id || "");
  const title = cleanText(fields.title || "", 120);
  const artist = cleanText(fields.artist || "", 120);
  if (!title || !artist) return null;

  let bestActive = null;
  let bestDeleted = null;
  for (const row of rows) {
    if (!row) continue;
    const isDeleted = Boolean(row.revoked);
    if (youtube_id && row.youtube_id && youtube_id === row.youtube_id) {
      if (!isDeleted) return { ...row, reason: "youtube" };
      bestDeleted = { ...row, reason: "deleted_youtube", score: 2 };
      continue;
    }
    const sim = songSimilarity({ title, artist }, row);
    if (!sim.match) continue;
    const hit = { ...row, reason: isDeleted ? "deleted_fuzzy" : "fuzzy", score: sim.score };
    if (!isDeleted) {
      if (!bestActive || sim.score > bestActive.score) bestActive = hit;
    } else if (!bestDeleted || sim.score > bestDeleted.score) {
      bestDeleted = hit;
    }
  }
  return bestActive || bestDeleted;
}

function songSimilarity(a, b) {
  const aTitle = songNorm(a?.title || "");
  const bTitle = songNorm(b?.title || "");
  const aArtist = songNorm(a?.artist || "");
  const bArtist = songNorm(b?.artist || "");

  const titleCov = tokenCoverage(songTokens(aTitle, "title"), songTokens(bTitle, "title"));
  const artistCov = tokenCoverage(songTokens(aArtist, "artist"), songTokens(bArtist, "artist"));
  const tightTitleA = tightSongTitle(aTitle);
  const tightTitleB = tightSongTitle(bTitle);
  const tightArtistA = tightSongArtist(aArtist);
  const tightArtistB = tightSongArtist(bArtist);
  const titleContains =
    tightTitleA.length >= 6
    && tightTitleB.length >= 6
    && (tightTitleA.includes(tightTitleB) || tightTitleB.includes(tightTitleA));
  const artistContains =
    tightArtistA.length >= 4
    && tightArtistB.length >= 4
    && (tightArtistA.includes(tightArtistB) || tightArtistB.includes(tightArtistA));
  const titleTypo = normalizedStringSimilarity(tightTitleA, tightTitleB);
  const artistTypo = normalizedStringSimilarity(tightArtistA, tightArtistB);

  const titleMatch = titleCov >= 0.7 || titleContains || titleTypo >= 0.86;
  const artistMatch = artistCov >= 0.62 || artistContains || artistTypo >= 0.84;
  const titleScore = Math.max(titleCov, titleTypo);
  const artistScore = Math.max(artistCov, artistTypo);
  const score = Number((titleScore * 0.58 + artistScore * 0.42).toFixed(3));
  const match = titleMatch && artistMatch;

  return { match, score, titleCov, artistCov, titleTypo, artistTypo };
}

function songNorm(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+[-|:]\s+/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tightSongTitle(value) {
  return songNorm(value)
    .replace(/\b(feat|ft|featuring)\b.*$/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tightSongArtist(value) {
  return songNorm(value)
    .replace(/\b(feat|ft|featuring|with|and|vs|x)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function songTokens(value, mode) {
  const raw = String(value || "").trim();
  if (!raw) return new Set();
  const stop = mode === "title" ? SONG_TITLE_STOP_WORDS : SONG_ARTIST_STOP_WORDS;
  const out = new Set();
  for (const token of raw.split(/\s+/)) {
    const t = String(token || "").trim();
    if (!t || t.length <= 1 || stop.has(t)) continue;
    out.add(t);
  }
  return out;
}

function tokenCoverage(a, b) {
  if (!a?.size || !b?.size) return 0;
  let hit = 0;
  for (const x of a.values()) {
    if (b.has(x)) hit += 1;
  }
  return hit / Math.min(a.size, b.size);
}

function normalizedStringSimilarity(a, b) {
  const x = String(a || "").replace(/\s+/g, " ").trim();
  const y = String(b || "").replace(/\s+/g, " ").trim();
  if (!x || !y) return 0;
  if (x === y) return 1;
  const maxLen = Math.max(x.length, y.length);
  if (maxLen === 0) return 1;
  const d = levenshteinDistance(x, y);
  return Math.max(0, 1 - d / maxLen);
}

function levenshteinDistance(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0) return m;
  if (m === 0) return n;

  let prev = new Array(m + 1);
  let curr = new Array(m + 1);
  for (let j = 0; j <= m; j += 1) prev[j] = j;

  for (let i = 1; i <= n; i += 1) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= m; j += 1) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      const del = prev[j] + 1;
      const ins = curr[j - 1] + 1;
      const sub = prev[j - 1] + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

function entryDomId(entry_id) {
  const clean = cleanEntryId(entry_id) || "song";
  const slug = clean.replace(/[^a-z0-9_-]+/g, "_").slice(0, 56);
  return `entry-${slug}-${hash32(clean)}`;
}

function hash32(input) {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function scrollToEntry(entry_id) {
  const id = entryDomId(entry_id);
  let node = document.getElementById(id);
  if (!node) {
    renderList();
    node = document.getElementById(id);
  }
  if (!node) return false;

  node.scrollIntoView({ behavior: "smooth", block: "center" });
  node.classList.remove("item-highlight");
  void node.offsetWidth;
  node.classList.add("item-highlight");
  window.setTimeout(() => {
    node?.classList.remove("item-highlight");
  }, 3000);
  return true;
}

async function publishEntryEvent({ entry_id, title, artist, youtube_id, youtube_url, user, owner_pubkey, created_at }) {
  const ownerPk = normPk(owner_pubkey || "");
  const ownerName = normName(user);
  const payload = {
    entry_id,
    title,
    artist,
    youtube_id,
    youtube_url,
    user: ownerName,
    owner_name: ownerName,
    owner_pubkey: ownerPk,
    created_at: unixOr(created_at, nowSec()),
  };
  const tags = [["d", entry_id]];
  if (isHex64(ownerPk)) tags.push(["p", ownerPk]);
  if (payload.youtube_id) tags.push(["yt", payload.youtube_id]);
  const ev = await signEvent(APP.kinds.entry, tags, payload);
  if (!ev) return -1;
  const ok = await publishEvent(ev);
  ingestEvent(ev);
  return ok;
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
  const entries = buildRows({ mode: "ranked" })
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

async function onPlayToggle(entry_id, youtube_id, { toggleSame = true, captureQueue = false } = {}) {
  await playYouTubeEntry(entry_id, youtube_id, { toggleSame, captureQueue });
}

function isPlayableRow(row) {
  return Boolean(row && row.youtube_id && !row.revoked && !row.owner_banned);
}

function resetPlaybackQueue() {
  state.youtube.queue.mode = state.list.mode;
  state.youtube.queue.entryIds = [];
  state.youtube.queue.index = -1;
  state.youtube.queue.capturedAt = 0;
  state.youtube.queue.shuffleSeedIds = [];
}

function rotateIdsToStart(ids, startEntryId) {
  const cleanStart = cleanEntryId(startEntryId || "");
  if (!cleanStart || ids.length === 0) return [...ids];
  const index = ids.indexOf(cleanStart);
  if (index < 0) return [...ids];
  return [...ids.slice(index), ...ids.slice(0, index)];
}

function capturePlaybackQueue(startEntryId) {
  const rows = buildRows({ mode: state.list.mode });
  const playableIds = rows.filter((row) => isPlayableRow(row)).map((row) => row.entry_id);
  if (playableIds.length === 0) {
    resetPlaybackQueue();
    return false;
  }
  const rotated = rotateIdsToStart(playableIds, startEntryId);
  state.youtube.queue.mode = state.list.mode;
  state.youtube.queue.entryIds = rotated;
  state.youtube.queue.index = 0;
  state.youtube.queue.capturedAt = nowSec();
  state.youtube.queue.shuffleSeedIds = state.list.mode === "shuffle" ? [...playableIds] : [];
  return true;
}

function ensurePlaybackQueue(seedEntryId = "") {
  if (state.youtube.queue.entryIds.length > 0) return true;
  const fallbackId = cleanEntryId(seedEntryId || state.youtube.currentEntryId || "");
  return capturePlaybackQueue(fallbackId);
}

function rowForCurrentPlayback() {
  const entryId = cleanEntryId(state.youtube.currentEntryId || "");
  const videoId = cleanYouTubeId(state.youtube.currentVideoId || "");
  const rows = buildBaseRows({ includeHiddenRevoked: true });
  if (entryId) {
    const byEntry = rows.find((r) => r.entry_id === entryId && r.youtube_id);
    if (byEntry) return byEntry;
  }
  if (videoId) {
    const byVideo = rows.find((r) => r.youtube_id === videoId);
    if (byVideo) return byVideo;
  }
  return null;
}

function resolvePlayableRowByEntryId(entry_id) {
  const cleanId = cleanEntryId(entry_id || "");
  if (!cleanId) return null;
  const row = buildBaseRows({ includeHiddenRevoked: true }).find((candidate) => candidate.entry_id === cleanId);
  return isPlayableRow(row) ? row : null;
}

function clonePlaybackQueue(queue = state.youtube.queue) {
  return {
    mode: queue?.mode || "ranked",
    entryIds: Array.isArray(queue?.entryIds) ? [...queue.entryIds] : [],
    index: Number.isInteger(queue?.index) ? queue.index : -1,
    capturedAt: unixOr(queue?.capturedAt, 0),
    shuffleSeedIds: Array.isArray(queue?.shuffleSeedIds) ? [...queue.shuffleSeedIds] : [],
  };
}

function appendShuffleQueuePass(queue, lastEntryId = "") {
  const targetQueue = queue || state.youtube.queue;
  const seeds = targetQueue.shuffleSeedIds.filter((id) => cleanEntryId(id));
  if (seeds.length === 0) return false;
  const nextPass = shuffleIds(seeds, lastEntryId);
  if (nextPass.length === 0) return false;
  targetQueue.entryIds.push(...nextPass);
  return true;
}

function findQueuedTargetInQueue(queue, direction) {
  if (queue.entryIds.length === 0) return null;

  const maxAttempts = Math.max(queue.entryIds.length + queue.shuffleSeedIds.length + 2, 4);
  let cursor = queue.index >= 0 ? queue.index : 0;
  let attempts = 0;

  while (attempts < maxAttempts) {
    if (direction < 0) {
      cursor = cursor <= 0 ? queue.entryIds.length - 1 : cursor - 1;
    } else {
      if (cursor + 1 >= queue.entryIds.length) {
        if (queue.mode === "shuffle") {
          if (!appendShuffleQueuePass(queue, queue.entryIds[cursor] || state.youtube.currentEntryId)) return null;
        } else {
          cursor = -1;
        }
      }
      cursor += 1;
    }
    const row = resolvePlayableRowByEntryId(queue.entryIds[cursor]);
    if (row) {
      return { row, index: cursor };
    }
    attempts += 1;
  }
  return null;
}

function findQueuedTarget(direction) {
  if (!ensurePlaybackQueue()) return null;
  return findQueuedTargetInQueue(state.youtube.queue, direction);
}

function previewQueuedTarget(direction) {
  if (!ensurePlaybackQueue()) return null;
  return findQueuedTargetInQueue(clonePlaybackQueue(state.youtube.queue), direction);
}

function stopHeuristicAdWatch() {
  if (state.youtube.ad.watchTimer) {
    clearInterval(state.youtube.ad.watchTimer);
    state.youtube.ad.watchTimer = 0;
  }
}

function setHeuristicAdState(active, targetVideoId = "", { pending = state.youtube.ad.pending } = {}) {
  const nextActive = Boolean(active);
  const nextPending = Boolean(pending);
  const nextVideoId = cleanYouTubeId(targetVideoId || "");
  const changed = state.youtube.ad.active !== nextActive
    || state.youtube.ad.pending !== nextPending
    || state.youtube.ad.lastTargetVideoId !== nextVideoId;
  state.youtube.ad.active = nextActive;
  state.youtube.ad.pending = nextPending;
  state.youtube.ad.lastTargetVideoId = nextVideoId;
  if (changed) renderMiniPlayer();
}

function clearHeuristicAdState({ unmute = false } = {}) {
  stopHeuristicAdWatch();
  const player = state.youtube.player;
  if (unmute && player && state.youtube.ad.muted) {
    try {
      player.unMute?.();
    } catch {
      // ignore player unmute failures
    }
  }
  state.youtube.ad.muted = false;
  setHeuristicAdState(false, "", { pending: false });
}

function isHeuristicAdLocked() {
  return Boolean(state.youtube.ad.pending || state.youtube.ad.active);
}

function resetCurrentPlayback({ resetQueue = false, unmute = true } = {}) {
  stopYouTubeProgressTicker();
  state.youtube.ad.retrySeq += 1;
  clearHeuristicAdState({ unmute });
  state.youtube.isPlaying = false;
  state.youtube.currentEntryId = "";
  state.youtube.currentVideoId = "";
  state.youtube.currentTime = 0;
  state.youtube.duration = 0;
  state.youtube.seeking = false;
  if (resetQueue) resetPlaybackQueue();
  updateMiniProgressUi();
}

function currentPlayerVideoId() {
  const player = state.youtube.player;
  if (!player) return "";
  try {
    const dataId = cleanYouTubeId(player.getVideoData?.()?.video_id || "");
    if (dataId) return dataId;
  } catch {
    // ignore
  }
  try {
    return cleanYouTubeId(player.getVideoUrl?.() || "");
  } catch {
    return "";
  }
}

function looksLikeTargetPlayback(player, youtube_id) {
  try {
    const states = window.YT?.PlayerState;
    const current = Number(player.getCurrentTime?.() || 0);
    const currentVideoId = currentPlayerVideoId();
    const stateCode = Number(player.getPlayerState?.() || -999);
    if (states && stateCode !== states.PLAYING) return false;
    if (current <= 0.2) return false;
    if (currentVideoId && currentVideoId !== youtube_id) return false;
    return true;
  } catch {
    return false;
  }
}

function waitMs(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

async function attemptYouTubePlaybackHeuristic(player, youtube_id) {
  const seq = ++state.youtube.ad.retrySeq;
  clearHeuristicAdState();
  setHeuristicAdState(false, youtube_id, { pending: true });

  for (let attempt = 0; attempt < 7; attempt += 1) {
    if (seq !== state.youtube.ad.retrySeq || state.youtube.currentVideoId !== youtube_id) return;
    try {
      if (attempt > 0) {
        player.loadVideoById(youtube_id);
      }
      player.playVideo?.();
    } catch {
      // keep trying
    }
    await waitMs(280);
    if (seq !== state.youtube.ad.retrySeq || state.youtube.currentVideoId !== youtube_id) return;
    if (looksLikeTargetPlayback(player, youtube_id)) {
      clearHeuristicAdState({ unmute: true });
      return;
    }
  }

  if (seq !== state.youtube.ad.retrySeq || state.youtube.currentVideoId !== youtube_id) return;
  setHeuristicAdState(true, youtube_id, { pending: false });
  try {
    player.mute?.();
    state.youtube.ad.muted = true;
  } catch {
    state.youtube.ad.muted = false;
  }
  stopHeuristicAdWatch();
  state.youtube.ad.watchTimer = window.setInterval(() => {
    if (seq !== state.youtube.ad.retrySeq || state.youtube.currentVideoId !== youtube_id) {
      clearHeuristicAdState({ unmute: false });
      return;
    }
    if (looksLikeTargetPlayback(player, youtube_id)) {
      clearHeuristicAdState({ unmute: true });
    }
  }, 700);
}

async function playYouTubeEntry(entry_id, youtube_id, { toggleSame = true, captureQueue = false, queueIndex = null } = {}) {
  if (!youtube_id) return false;
  const sameEntry = state.youtube.currentEntryId === entry_id;
  const sameVideo = state.youtube.currentVideoId === youtube_id;
  if (captureQueue && (!sameEntry || state.youtube.queue.entryIds.length === 0)) {
    capturePlaybackQueue(entry_id);
  }
  try {
    const player = await ensureYouTubePlayer(youtube_id);

    if (toggleSame && sameEntry && state.youtube.isPlaying) {
      player.pauseVideo();
      state.youtube.isPlaying = false;
      stopYouTubeProgressTicker();
      void syncYouTubeProgressFromPlayer();
      renderPlaybackUi();
      return true;
    }

    if (!sameEntry || !sameVideo) {
      player.loadVideoById(youtube_id);
    } else {
      player.playVideo();
    }

    state.youtube.currentEntryId = entry_id;
    state.youtube.currentVideoId = youtube_id;
    state.youtube.isPlaying = true;
    state.youtube.currentTime = 0;
    state.youtube.duration = 0;
    if (Number.isInteger(queueIndex) && queueIndex >= 0) {
      state.youtube.queue.index = queueIndex;
    } else if (state.youtube.queue.entryIds.length > 0) {
      const resolvedIndex = state.youtube.queue.entryIds.lastIndexOf(cleanEntryId(entry_id));
      if (resolvedIndex >= 0) {
        state.youtube.queue.index = resolvedIndex;
      }
    }
    startYouTubeProgressTicker();
    void attemptYouTubePlaybackHeuristic(player, youtube_id);
    renderPlaybackUi();
    return true;
  } catch (err) {
    console.error(err);
    setStatus("youtube player unavailable");
    return false;
  }
}

async function autoplayNextPopularAfter(currentEntryId) {
  if (!ensurePlaybackQueue(currentEntryId)) {
    resetCurrentPlayback({ resetQueue: true });
    renderPlaybackUi();
    return;
  }
  const next = findQueuedTarget(1);
  if (!next) {
    resetCurrentPlayback({ resetQueue: true });
    renderPlaybackUi();
    return;
  }

  const ok = await playYouTubeEntry(next.row.entry_id, next.row.youtube_id, { toggleSame: false, queueIndex: next.index });
  if (ok) {
    setStatus(`autoplay next: ${next.row.title} - ${next.row.artist}`);
  } else {
    setStatus("autoplay next failed");
  }
}

async function onMiniPlayPause() {
  if (!state.identity) return;
  if (isHeuristicAdLocked()) return;
  const current = rowForCurrentPlayback();
  if (current?.youtube_id) {
    await playYouTubeEntry(current.entry_id, current.youtube_id, { toggleSame: true, captureQueue: false });
    return;
  }
  const rows = buildRows({ mode: state.list.mode }).filter((row) => isPlayableRow(row));
  if (rows.length === 0) {
    showToast("No playable songs yet.", { kind: "info", timeoutMs: 1800 });
    return;
  }
  await playYouTubeEntry(rows[0].entry_id, rows[0].youtube_id, { toggleSame: false, captureQueue: true });
}

async function onMiniNext() {
  if (!state.identity) return;
  const target = findQueuedTarget(1);
  if (!target) return;
  await playYouTubeEntry(target.row.entry_id, target.row.youtube_id, { toggleSame: false, queueIndex: target.index });
}

async function onMiniPrev() {
  if (!state.identity) return;
  const target = findQueuedTarget(-1);
  if (!target) return;
  await playYouTubeEntry(target.row.entry_id, target.row.youtube_id, { toggleSame: false, queueIndex: target.index });
}

function syncMiniSwipePreview(direction, row) {
  const isPrev = direction < 0;
  const iconHost = isPrev ? el.miniPrevPreviewIcon : el.miniNextPreviewIcon;
  const thumb = isPrev ? el.miniPrevPreviewThumb : el.miniNextPreviewThumb;
  const title = isPrev ? el.miniPrevPreviewTitle : el.miniNextPreviewTitle;
  const artist = isPrev ? el.miniPrevPreviewArtist : el.miniNextPreviewArtist;
  const zone = isPrev ? el.miniPrevPreview : el.miniNextPreview;
  if (iconHost) {
    iconHost.replaceChildren(createMiniControlIcon(isPrev ? "prev" : "next"));
  }
  if (title) title.textContent = row?.title || "";
  if (artist) artist.textContent = row?.artist || "";
  if (thumb) {
    if (row?.youtube_id) {
      setImageSource(thumb, `https://i.ytimg.com/vi/${row.youtube_id}/hqdefault.jpg`);
      thumb.alt = "";
      thumb.classList.remove("hidden");
    } else {
      setImageSource(thumb, "");
      thumb.alt = "";
      thumb.classList.add("hidden");
    }
  }
  if (zone) zone.classList.toggle("empty", !row);
}

function setMiniSwipeVisual(shiftPx = 0, direction = 0, armed = false) {
  const node = el.miniPlayer;
  if (!node) return;
  const width = Math.max(1, node.clientWidth || 1);
  const threshold = swipeTriggerDistance(width);
  const progress = Math.min(Math.abs(shiftPx) / threshold, 1);
  node.style.setProperty("--swipe-shift", `${shiftPx}px`);
  node.style.setProperty("--swipe-right-progress", direction > 0 ? String(progress) : "0");
  node.style.setProperty("--swipe-left-progress", direction < 0 ? String(progress) : "0");
  node.classList.toggle("swiping", Math.abs(shiftPx) > 0.5);
  node.classList.toggle("swipe-right", direction > 0 && Math.abs(shiftPx) > 0.5);
  node.classList.toggle("swipe-left", direction < 0 && Math.abs(shiftPx) > 0.5);
  node.classList.toggle("swipe-armed", armed);
}

function isMiniPlayerBackgroundTarget(target) {
  if (!(target instanceof Element)) return false;
  return !target.closest(
    "button, a, input, textarea, select, label, .mini-thumb-shell, .mini-top, .mini-controls-row, .mini-progress-row, .mini-progress-hitbox",
  );
}

function scrollToCurrentPlaybackEntry() {
  const entryId = cleanEntryId(state.youtube.currentEntryId || "");
  if (!entryId) return;
  scrollToEntry(entryId);
}

function bindMiniPlayerBackgroundLongPress(node) {
  if (!node) return;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let holdTimer = 0;
  let holdTriggered = false;

  const clearHold = () => {
    if (holdTimer) {
      clearTimeout(holdTimer);
      holdTimer = 0;
    }
  };

  node.addEventListener("pointerdown", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!isMiniPlayerBackgroundTarget(target)) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    holdTriggered = false;
    clearHold();
    holdTimer = window.setTimeout(() => {
      holdTimer = 0;
      if (pointerId !== event.pointerId) return;
      holdTriggered = true;
      triggerHapticPulse();
      scrollToCurrentPlaybackEntry();
    }, MINI_BACKGROUND_HOLD_MS);
  });

  node.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
      clearHold();
    }
  });

  node.addEventListener("pointerup", (event) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    clearHold();
    if (!holdTriggered) return;
    holdTriggered = false;
    event.preventDefault();
    event.stopPropagation();
  });

  node.addEventListener("pointercancel", () => {
    pointerId = null;
    holdTriggered = false;
    clearHold();
  });

  node.addEventListener("pointerleave", () => {
    pointerId = null;
    holdTriggered = false;
    clearHold();
  });

  node.addEventListener("contextmenu", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!isMiniPlayerBackgroundTarget(target)) return;
    event.preventDefault();
  });
}

function onMiniPlayerBackgroundClick(event) {
  const target = event.target instanceof Element ? event.target : null;
  if (!isMiniPlayerBackgroundTarget(target)) return;
  scrollToCurrentPlaybackEntry();
}

function bindMiniPlayerSwipe(node) {
  if (!node) return;
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let swipeHandled = false;
  let shouldSuppressClick = false;
  let thresholdBuzzed = false;
  let previewDirection = 0;

  node.addEventListener("pointerdown", (event) => {
    if (!isTouchLikeDevice()) return;
    if (event.pointerType && event.pointerType !== "touch") return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("button, a, input, textarea, select, label, .mini-progress-hitbox")) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    swipeHandled = false;
    shouldSuppressClick = false;
    thresholdBuzzed = false;
    previewDirection = 0;
    setMiniSwipeVisual();
  });

  node.addEventListener("pointermove", (event) => {
    if (pointerId !== event.pointerId) return;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    if (Math.abs(dx) <= Math.abs(dy) * 1.1) {
      previewDirection = 0;
      setMiniSwipeVisual();
      return;
    }
    const direction = dx < 0 ? 1 : -1;
    const preview = previewQueuedTarget(direction);
    if (!preview?.row) {
      previewDirection = 0;
      setMiniSwipeVisual();
      return;
    }
    shouldSuppressClick = true;
    if (previewDirection !== direction) {
      syncMiniSwipePreview(direction, preview.row);
      previewDirection = direction;
    }
    const threshold = swipeTriggerDistance(node.clientWidth);
    const shift = Math.max(-threshold, Math.min(threshold, dx));
    const armed = Math.abs(shift) >= threshold - 0.5;
    if (armed && !thresholdBuzzed) {
      thresholdBuzzed = true;
      triggerHapticPulse();
    } else if (!armed) {
      thresholdBuzzed = false;
    }
    setMiniSwipeVisual(shift, dx > 0 ? 1 : -1, armed);
  });

  node.addEventListener("pointerup", (event) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    const dx = event.clientX - startX;
    const dy = event.clientY - startY;
    setMiniSwipeVisual();
    if (Math.abs(dx) < Math.abs(dy) * 1.2) return;
    const direction = dx < 0 ? 1 : -1;
    const preview = previewQueuedTarget(direction);
    if (!preview?.row) return;
    const threshold = swipeTriggerDistance(node.clientWidth);
    if (Math.abs(dx) < threshold) return;
    swipeHandled = true;
    event.preventDefault();
    if (dx < 0) void onMiniNext();
    else void onMiniPrev();
  });

  node.addEventListener("pointercancel", () => {
    pointerId = null;
    swipeHandled = false;
    shouldSuppressClick = false;
    thresholdBuzzed = false;
    previewDirection = 0;
    setMiniSwipeVisual();
  });

  node.addEventListener("click", (event) => {
    if (!swipeHandled && !shouldSuppressClick) return;
    swipeHandled = false;
    shouldSuppressClick = false;
    event.preventDefault();
    event.stopPropagation();
  }, true);
}

function onMiniSeekInput(event) {
  const input = event?.target instanceof HTMLInputElement ? event.target : el.miniProgress;
  if (!input) return;
  state.youtube.seeking = true;
  const value = Number(input.value);
  if (Number.isFinite(value) && value >= 0) {
    state.youtube.currentTime = value;
    updateMiniProgressUi();
  }
}

async function onMiniSeekCommit() {
  const input = el.miniProgress;
  const player = state.youtube.player;
  if (!input || !player) {
    state.youtube.seeking = false;
    return;
  }
  const value = Number(input.value);
  const seekTo = Number.isFinite(value) && value >= 0 ? value : 0;
  state.youtube.seeking = false;
  try {
    player.seekTo(seekTo, true);
    state.youtube.currentTime = seekTo;
    updateMiniProgressUi();
  } catch (err) {
    console.error(err);
  }
}

function startYouTubeProgressTicker() {
  stopYouTubeProgressTicker();
  state.youtube.progressTimer = window.setInterval(() => {
    void syncYouTubeProgressFromPlayer();
  }, 500);
}

function stopYouTubeProgressTicker() {
  if (state.youtube.progressTimer) {
    clearInterval(state.youtube.progressTimer);
    state.youtube.progressTimer = 0;
  }
}

async function syncYouTubeProgressFromPlayer() {
  const player = state.youtube.player;
  if (!player) return;
  try {
    const durationRaw = Number(player.getDuration?.() || 0);
    const currentRaw = Number(player.getCurrentTime?.() || 0);
    if (Number.isFinite(durationRaw) && durationRaw >= 0) {
      state.youtube.duration = durationRaw;
    }
    if (!state.youtube.seeking && Number.isFinite(currentRaw) && currentRaw >= 0) {
      state.youtube.currentTime = currentRaw;
    }
    if (state.youtube.currentVideoId && looksLikeTargetPlayback(player, state.youtube.currentVideoId)) {
      clearHeuristicAdState({ unmute: true });
    }
    updateMiniProgressUi();
  } catch {
    // ignore polling failures
  }
}

function setImageSource(img, src) {
  if (!(img instanceof HTMLImageElement)) return;
  const nextSrc = String(src || "");
  const currentSrc = img.getAttribute("src") || "";
  if (!nextSrc) {
    if (currentSrc) img.removeAttribute("src");
    return;
  }
  if (currentSrc !== nextSrc) {
    img.src = nextSrc;
  }
}

function prefersReducedMotion() {
  try {
    return Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
  } catch {
    return false;
  }
}

function clearMiniMarqueeLine(node) {
  if (!(node instanceof HTMLElement)) return;
  const timer = miniMarqueeTimers.get(node);
  if (timer) {
    cancelAnimationFrame(timer);
    miniMarqueeTimers.delete(node);
  }
  node.style.transform = "";
  node.style.removeProperty("--mini-marquee-offset");
  node.parentElement?.classList.remove("marquee-active");
}

function startMiniMarqueeLine(node) {
  if (!(node instanceof HTMLElement)) return;
  const clip = node.parentElement;
  if (!(clip instanceof HTMLElement) || !clip.classList.contains("mini-line-clip")) return;

  clearMiniMarqueeLine(node);
  if (prefersReducedMotion()) return;

  const overflow = Math.ceil(node.scrollWidth - clip.clientWidth);
  if (overflow <= 2 || clip.clientWidth <= 0) return;

  clip.classList.add("marquee-active");
  const moveMs = Math.max(1400, Math.round((overflow / MINI_MARQUEE_PX_PER_SEC) * 1000));
  const cycleMs = MINI_MARQUEE_DELAY_MS + moveMs + MINI_MARQUEE_DELAY_MS;
  const startedAt = (typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now();

  const tick = (now) => {
    const timestamp = Number.isFinite(now) ? now : ((typeof performance !== "undefined" && typeof performance.now === "function") ? performance.now() : Date.now());
    const elapsed = (timestamp - startedAt) % cycleMs;
    let offset = 0;
    if (elapsed > MINI_MARQUEE_DELAY_MS) {
      if (elapsed < MINI_MARQUEE_DELAY_MS + moveMs) {
        offset = -overflow * ((elapsed - MINI_MARQUEE_DELAY_MS) / moveMs);
      } else {
        offset = -overflow;
      }
    }
    node.style.transform = `translate3d(${offset}px, 0, 0)`;
    miniMarqueeTimers.set(node, requestAnimationFrame(tick));
  };

  miniMarqueeTimers.set(node, requestAnimationFrame(tick));
}

function scheduleMiniMarqueeSync() {
  if (miniMarqueeRefreshFrame) {
    cancelAnimationFrame(miniMarqueeRefreshFrame);
  }
  miniMarqueeRefreshFrame = requestAnimationFrame(() => {
    miniMarqueeRefreshFrame = 0;
    startMiniMarqueeLine(el.miniPlayerTitle);
    startMiniMarqueeLine(el.miniPlayerArtist);
  });
}

function renderMiniPlayer() {
  const host = el.miniPlayer;
  if (!host) return;
  const row = state.identity ? rowForCurrentPlayback() : null;
  const show = Boolean(row);
  host.classList.toggle("hidden", !show);
  document.body.classList.toggle("mini-player-visible", show);
  if (!show) {
    host.classList.remove("mini-ad-active");
    setMiniSwipeVisual();
    clearMiniMarqueeLine(el.miniPlayerTitle);
    clearMiniMarqueeLine(el.miniPlayerArtist);
    if (el.miniThumbImage) {
      setImageSource(el.miniThumbImage, "");
      el.miniThumbImage.alt = "";
      el.miniThumbImage.parentElement?.classList.add("hidden");
    }
    syncMiniSwipePreview(-1, null);
    syncMiniSwipePreview(1, null);
    return;
  }
  const adLocked = isHeuristicAdLocked();
  host.classList.toggle("mini-ad-active", adLocked);
  if (el.miniPlayerTitle) el.miniPlayerTitle.textContent = row.title || "Unknown title";
  if (el.miniPlayerArtist) el.miniPlayerArtist.textContent = row.artist || "Unknown artist";
  if (el.miniThumbImage) {
    const hasThumb = Boolean(row.youtube_id);
    el.miniThumbImage.parentElement?.classList.toggle("hidden", !hasThumb);
    if (hasThumb) {
      setImageSource(el.miniThumbImage, `https://i.ytimg.com/vi/${row.youtube_id}/hqdefault.jpg`);
      el.miniThumbImage.alt = "";
    } else {
      setImageSource(el.miniThumbImage, "");
      el.miniThumbImage.alt = "";
    }
  }
  syncMiniSwipePreview(-1, previewQueuedTarget(-1)?.row || null);
  syncMiniSwipePreview(1, previewQueuedTarget(1)?.row || null);
  if (el.miniPrevBtn) {
    el.miniPrevBtn.replaceChildren(createMiniControlIcon("prev"));
    el.miniPrevBtn.setAttribute("aria-label", "previous");
    el.miniPrevBtn.title = "previous";
  }
  if (el.miniPlayPauseBtn) {
    if (adLocked) {
      const adMark = document.createElement("span");
      adMark.className = "mini-ad-mark";
      adMark.textContent = "⛛";
      el.miniPlayPauseBtn.replaceChildren(adMark);
      const label = state.youtube.ad.pending ? "ad bypass in progress" : "ad in progress";
      el.miniPlayPauseBtn.setAttribute("aria-label", label);
      el.miniPlayPauseBtn.title = label;
    } else {
      el.miniPlayPauseBtn.replaceChildren(createMiniControlIcon("playpause", state.youtube.isPlaying));
      el.miniPlayPauseBtn.setAttribute("aria-label", state.youtube.isPlaying ? "pause" : "play");
      el.miniPlayPauseBtn.title = state.youtube.isPlaying ? "pause" : "play";
    }
  }
  if (el.miniNextBtn) {
    el.miniNextBtn.replaceChildren(createMiniControlIcon("next"));
    el.miniNextBtn.setAttribute("aria-label", "next");
    el.miniNextBtn.title = "next";
  }
  updateMiniProgressUi();
  scheduleMiniMarqueeSync();
}

function updateMiniProgressUi() {
  const input = el.miniProgress;
  const elapsedNode = el.miniElapsed;
  const durationNode = el.miniDuration;
  const duration = Math.max(0, Math.floor(state.youtube.duration || 0));
  const current = Math.max(0, Math.floor(state.youtube.currentTime || 0));
  if (input && !state.youtube.seeking) {
    input.max = String(Math.max(1, duration || 1));
    input.value = String(Math.min(current, Math.max(1, duration || 1)));
  }
  if (elapsedNode) {
    const shown = input && state.youtube.seeking ? Number(input.value) || current : current;
    elapsedNode.textContent = formatClock(shown);
  }
  if (durationNode) durationNode.textContent = formatClock(duration);
}

function formatClock(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
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
            void syncYouTubeProgressFromPlayer();
            resolve(player);
          },
          onStateChange: onYouTubeStateChange,
          onError: () => {
            resetCurrentPlayback();
            renderPlaybackUi();
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
    startYouTubeProgressTicker();
    void syncYouTubeProgressFromPlayer();
  } else if (code === states.PAUSED || code === states.CUED) {
    state.youtube.isPlaying = false;
    stopYouTubeProgressTicker();
    void syncYouTubeProgressFromPlayer();
  } else if (code === states.ENDED) {
    clearHeuristicAdState({ unmute: true });
    stopYouTubeProgressTicker();
    state.youtube.currentTime = Math.max(state.youtube.currentTime, state.youtube.duration);
    updateMiniProgressUi();
    const finishedEntryId = state.youtube.currentEntryId;
    void autoplayNextPopularAfter(finishedEntryId);
    return;
  }
  renderPlaybackUi();
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

function rememberEntryOwner(entry_id, owner_pubkey, owner_name, created_at, event_id) {
  const id = cleanEntryId(entry_id);
  const pubkey = normPk(owner_pubkey || "");
  if (!id || !isHex64(pubkey)) return null;

  const next = {
    pubkey,
    user: normName(owner_name || ""),
    created_at: unixOr(created_at, nowSec()),
    id: String(event_id || ""),
  };

  const cur = state.entryOwners.get(id);
  if (!cur) {
    state.entryOwners.set(id, next);
    return next;
  }

  const isEarlier =
    next.created_at < cur.created_at
    || (next.created_at === cur.created_at && next.id && cur.id && next.id.localeCompare(cur.id) < 0);

  if (isEarlier) {
    const merged = {
      pubkey: next.pubkey,
      user: next.user || cur.user,
      created_at: next.created_at,
      id: next.id || cur.id,
    };
    state.entryOwners.set(id, merged);
    return merged;
  }

  if (!cur.user && next.user) {
    const merged = { ...cur, user: next.user };
    state.entryOwners.set(id, merged);
    return merged;
  }

  return cur;
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

function showToast(message, { kind = "info", timeoutMs = 3200 } = {}) {
  const text = cleanText(message, 240);
  if (!text) return;
  const host = el.toastStack;
  if (!host) {
    console.log(`[nk3:toast] ${text}`);
    return;
  }
  const toast = document.createElement("div");
  toast.className = `toast ${kind === "warn" ? "warn" : "info"}`;
  toast.textContent = text;
  host.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });
  const ttl = Math.max(1400, Number(timeoutMs) || 0);
  window.setTimeout(() => {
    toast.classList.remove("show");
    toast.classList.add("hide");
    window.setTimeout(() => {
      toast.remove();
    }, 220);
  }, ttl);
}

function showActionToast(message, actionLabel, onAction, { kind = "info" } = {}) {
  const text = cleanText(message, 240);
  const label = cleanText(actionLabel, 24);
  if (!text || !label) return null;
  const host = el.toastStack;
  if (!host) return null;

  const toast = document.createElement("div");
  toast.className = `toast ${kind === "warn" ? "warn" : "info"} action`;

  const msg = document.createElement("span");
  msg.textContent = text;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "toast-action";
  btn.textContent = label;
  btn.addEventListener("click", () => {
    try {
      onAction?.();
    } catch (err) {
      console.error(err);
    }
  });

  toast.append(msg, btn);
  host.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.add("show");
  });
  return toast;
}

function dismissActionToast(node) {
  if (!node) return;
  node.classList.remove("show");
  node.classList.add("hide");
  window.setTimeout(() => {
    node.remove();
  }, 220);
}

function notifyAppUpdate(registration) {
  const waiting = registration?.waiting;
  if (!waiting) return;
  if (updateToastNode && updateToastNode.isConnected) return;
  updateToastNode = showActionToast(
    "Update available.",
    "reload",
    () => {
      try {
        waiting.postMessage({ type: "SKIP_WAITING" });
      } catch (err) {
        console.error(err);
      }
    },
    { kind: "info" },
  );
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
  const owned = state.entryOwners.get(cleanEntryId(entry_id));
  if (owned && isHex64(normPk(owned.pubkey || ""))) {
    return normPk(owned.pubkey);
  }
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
  const row = buildBaseRows({ includeHiddenRevoked: true }).find((r) => r.entry_id === ctx.entry_id);
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

function visibleModalNodes() {
  return [...document.querySelectorAll(".modal:not(.hidden)")];
}

function canRestoreFocus(node) {
  return Boolean(node && node.isConnected && !node.closest(".hidden") && node.getClientRects().length > 0);
}

function syncModalEnvironment() {
  document.body.classList.toggle("modal-open", visibleModalNodes().length > 0);
}

function modalFocusTarget(node) {
  if (!node) return null;
  return node.querySelector(
    "input:not([disabled]), textarea:not([disabled]), select:not([disabled])",
  ) || node.querySelector(".modal-card") || node.querySelector(".modal-close") || node.querySelector(
    "button:not([disabled]):not(.hidden):not([data-close-modal]), a[href], [tabindex]:not([tabindex='-1'])",
  ) || node;
}

function openModal(node) {
  if (!node) return;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (canRestoreFocus(active) && !active.closest(".modal")) {
    state.modal.lastFocused = active;
  }
  node.classList.remove("hidden");
  const card = node.querySelector(".modal-card");
  if (card instanceof HTMLElement && !card.hasAttribute("tabindex")) {
    card.setAttribute("tabindex", "-1");
  }
  if (card instanceof HTMLElement) {
    card.scrollTop = 0;
  }
  if (node instanceof HTMLElement) {
    node.scrollTop = 0;
  }
  syncModalEnvironment();
  const focusTarget = modalFocusTarget(node);
  window.requestAnimationFrame(() => {
    if (!(focusTarget instanceof HTMLElement)) return;
    try {
      focusTarget.focus({ preventScroll: true });
    } catch {
      focusTarget.focus();
    }
  });
}

function closeModal(node, { restoreFocus = true } = {}) {
  if (!node || node.classList.contains("hidden")) return;
  node.classList.add("hidden");
  if (node === el.userModal) {
    state.userModalContext = null;
  }
  if (node === el.editSongModal) {
    state.editContext = null;
  }
  if (node === el.deleteConfirmModal) {
    state.deleteConfirmContext = null;
  }
  syncModalEnvironment();
  if (!restoreFocus) return;
  const visible = visibleModalNodes();
  if (visible.length > 0) {
    const focusTarget = modalFocusTarget(visible[visible.length - 1]);
    window.requestAnimationFrame(() => {
      if (!(focusTarget instanceof HTMLElement)) return;
      try {
        focusTarget.focus({ preventScroll: true });
      } catch {
        focusTarget.focus();
      }
    });
    return;
  }
  const restore = state.modal.lastFocused;
  if (!canRestoreFocus(restore)) return;
  window.requestAnimationFrame(() => {
    try {
      restore.focus({ preventScroll: true });
    } catch {
      restore.focus();
    }
  });
}
