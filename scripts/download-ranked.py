#!/usr/bin/env python3
from __future__ import annotations

import argparse
import getpass
import hashlib
import importlib
import importlib.util
import json
import os
import platform
import re
import shutil
import string
import subprocess
import sys
import tarfile
import time
import urllib.request
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


REPO_ROOT = Path(__file__).resolve().parents[1]
TOOLS_DIR = REPO_ROOT / ".nk3-tools"
PYDEPS_DIR = TOOLS_DIR / "pydeps"
DOWNLOAD_DIR = REPO_ROOT / "download"
FFMPEG_DIR = TOOLS_DIR / "ffmpeg"

APP_TAG = "no-kings-playlist"
KIND_ENTRY = 34123
KIND_VOTE = 34124
KIND_MOD = 34125
KIND_SNAPSHOT = 34126
KIND_ADMIN_CLAIM = 34127
KIND_ADMIN_ROLE = 34128
KIND_USER_MOD = 34129
KIND_NAME_CLAIM = 34130

EVENT_LIMIT = 5000
DEFAULT_RELAYS = [
    "ws://127.0.0.1:4848",
    "wss://relay.damus.io",
    "wss://relay.primal.net",
    "wss://nos.lol",
]
DEFAULT_SNAPSHOT = [
    {
        "entry_id": "seed:no-kings:1",
        "title": "Killing in the Name",
        "artist": "Rage Against the Machine",
        "user": "seed",
        "created_at": 1710000000,
    },
    {
        "entry_id": "seed:no-kings:2",
        "title": "Fight the Power",
        "artist": "Public Enemy",
        "user": "seed",
        "created_at": 1710000100,
    },
    {
        "entry_id": "seed:no-kings:3",
        "title": "Alright",
        "artist": "Kendrick Lamar",
        "user": "seed",
        "created_at": 1710000200,
    },
]

DEPENDENCIES = {
    "ecdsa": "ecdsa>=0.19.0",
    "websocket": "websocket-client>=1.8.0",
    "yt_dlp": "yt-dlp>=2025.01.15",
}
FFMPEG_RELEASE_API = "https://api.github.com/repos/BtbN/FFmpeg-Builds/releases/latest"


@dataclass
class RelayFetchResult:
    relay: str
    ok: bool
    event_count: int = 0
    note: str = ""


@dataclass
class State:
    usernames: dict[str, dict[str, Any]] = field(default_factory=dict)
    entry_owners: dict[str, dict[str, Any]] = field(default_factory=dict)
    entries: dict[str, dict[str, Any]] = field(default_factory=dict)
    votes: dict[str, dict[str, dict[str, Any]]] = field(default_factory=dict)
    admin_claims: list[dict[str, Any]] = field(default_factory=list)
    admin_role_events: list[dict[str, Any]] = field(default_factory=list)
    user_mod_events: list[dict[str, Any]] = field(default_factory=list)
    mod_events: list[dict[str, Any]] = field(default_factory=list)
    name_claim_events: list[dict[str, Any]] = field(default_factory=list)
    snapshot_events: list[dict[str, Any]] = field(default_factory=list)
    admin: dict[str, Any] = field(default_factory=lambda: {"pubkey": "", "claim_event": None})
    admins: set[str] = field(default_factory=set)
    user_bans: dict[str, dict[str, Any]] = field(default_factory=dict)
    name_owner_by_name: dict[str, dict[str, Any]] = field(default_factory=dict)
    name_by_pubkey: dict[str, str] = field(default_factory=dict)
    mods: dict[str, dict[str, Any]] = field(default_factory=dict)
    snapshot: dict[str, Any] | None = None


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sign in with NK3 alias/password, fetch the ranked list, and download YouTube-backed tracks with yt-dlp.",
    )
    parser.add_argument("--alias", help="Alias to sign in as")
    parser.add_argument("--relay", action="append", help="Relay to query. Repeat to override defaults")
    parser.add_argument("--top", type=int, default=0, help="Only download the top N YouTube-backed songs")
    parser.add_argument("--list-only", action="store_true", help="Fetch and export the ranked list without downloading")
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Skip confirmations",
    )
    parser.add_argument("--event-limit", type=int, default=EVENT_LIMIT, help="Per-relay nostr query limit")
    parser.add_argument("--download-dir", default=str(DOWNLOAD_DIR), help="Output directory for exports and downloads")
    return parser.parse_args()


def ensure_python_deps() -> None:
    PYDEPS_DIR.mkdir(parents=True, exist_ok=True)
    if str(PYDEPS_DIR) not in sys.path:
        sys.path.insert(0, str(PYDEPS_DIR))

    missing = [requirement for module, requirement in DEPENDENCIES.items() if importlib.util.find_spec(module) is None]
    if not missing:
        return

    print("Installing local helper dependencies...")
    cmd = [
        sys.executable,
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--upgrade",
        "--target",
        str(PYDEPS_DIR),
        *missing,
    ]
    try:
        subprocess.check_call(cmd)
    except subprocess.CalledProcessError as exc:
        raise SystemExit(f"dependency install failed ({exc.returncode})") from exc
    importlib.invalidate_caches()


def now_sec() -> int:
    return int(time.time())


def norm_name(value: str) -> str:
    return str(value or "").strip().lstrip("@")[:32]


def norm_pk(value: str) -> str:
    return str(value or "").strip().lower()


def is_hex64(value: str) -> bool:
    return bool(re.fullmatch(r"[0-9a-f]{64}", norm_pk(value)))


def clean_text(value: str, max_len: int) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()[:max_len]


def clean_filename(value: str, max_len: int) -> str:
    text = clean_text(value, max_len)
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "-", text)
    text = text.strip(" .-_")
    return text or "untitled"


def clean_entry_id(value: str) -> str:
    text = str(value or "").strip().lower()[:120]
    return text if text and re.fullmatch(r"[a-z0-9:_-]+", text) else ""


def unix_or(value: Any, fallback: int) -> int:
    try:
        num = int(value)
    except (TypeError, ValueError):
        return fallback
    return num if num > 0 else fallback


def clamp_vote(value: Any) -> int:
    try:
        num = int(value)
    except (TypeError, ValueError):
        return 0
    if num > 0:
        return 1
    if num < 0:
        return -1
    return 0


def parse_obj(text: Any) -> dict[str, Any] | None:
    if not isinstance(text, str):
        return None
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def first_tag(event: dict[str, Any], key: str) -> str:
    for tag in event.get("tags") or []:
        if isinstance(tag, list) and len(tag) > 1 and str(tag[0]) == key:
            return str(tag[1] or "")
    return ""


def has_tag(event: dict[str, Any], key: str, value: str) -> bool:
    for tag in event.get("tags") or []:
        if isinstance(tag, list) and len(tag) > 1 and str(tag[0]) == key and str(tag[1]) == value:
            return True
    return False


def short_pk(pubkey: str) -> str:
    clean = norm_pk(pubkey)
    if len(clean) < 12:
        return clean or "unknown"
    return f"{clean[:8]}:{clean[-4:]}"


def bytes_to_hex(value: bytes) -> str:
    return value.hex()


def derive_secret_key(passphrase: str) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256",
        passphrase.encode("utf-8"),
        f"nk3:{APP_TAG}:account-v2".encode("utf-8"),
        210000,
        dklen=32,
    )


def derive_legacy_secret_key(passphrase: str, alias: str) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256",
        passphrase.encode("utf-8"),
        f"nk3:{APP_TAG}:{alias.lower()}".encode("utf-8"),
        210000,
        dklen=32,
    )


def secret_key_to_pubkey(secret_key: bytes) -> str:
    from ecdsa import SECP256k1, SigningKey

    signing_key = SigningKey.from_string(secret_key, curve=SECP256k1)
    verifying_key = signing_key.verifying_key.to_string()
    return bytes_to_hex(verifying_key[:32])


def remember_name(state: State, pubkey: str, name: str, created_at: int) -> None:
    clean_name = norm_name(name)
    clean_pubkey = norm_pk(pubkey)
    if not clean_name or not is_hex64(clean_pubkey):
        return
    current = state.usernames.get(clean_pubkey)
    if not current or current["created_at"] <= created_at:
        state.usernames[clean_pubkey] = {"name": clean_name, "created_at": created_at}


def remember_entry_owner(state: State, entry_id: str, owner_pubkey: str, owner_name: str, created_at: int, event_id: str) -> dict[str, Any] | None:
    clean_id = clean_entry_id(entry_id)
    clean_pubkey = norm_pk(owner_pubkey)
    if not clean_id or not is_hex64(clean_pubkey):
        return None

    next_owner = {
        "pubkey": clean_pubkey,
        "user": norm_name(owner_name),
        "created_at": unix_or(created_at, now_sec()),
        "id": str(event_id or ""),
    }
    current = state.entry_owners.get(clean_id)
    if not current:
        state.entry_owners[clean_id] = next_owner
        return next_owner

    earlier = next_owner["created_at"] < current["created_at"]
    same_time_earlier_id = (
        next_owner["created_at"] == current["created_at"]
        and next_owner["id"]
        and current["id"]
        and next_owner["id"] < current["id"]
    )
    if earlier or same_time_earlier_id:
        merged = {
            "pubkey": next_owner["pubkey"],
            "user": next_owner["user"] or current["user"],
            "created_at": next_owner["created_at"],
            "id": next_owner["id"] or current["id"],
        }
        state.entry_owners[clean_id] = merged
        return merged

    if not current["user"] and next_owner["user"]:
        merged = {**current, "user": next_owner["user"]}
        state.entry_owners[clean_id] = merged
        return merged

    return current


def resolve_name(state: State, pubkey: str) -> str:
    clean_pubkey = norm_pk(pubkey)
    claimed = state.name_by_pubkey.get(clean_pubkey)
    if claimed:
        return claimed
    remembered = state.usernames.get(clean_pubkey)
    if remembered:
        return remembered["name"]
    return short_pk(clean_pubkey)


def youtube_id_from_any(value: str) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""

    direct = clean_youtube_id(raw)
    if direct:
        return direct

    try:
        parsed = urlparse(raw)
    except ValueError:
        return ""

    host = parsed.netloc.lower().removeprefix("www.")
    if host == "youtu.be":
        path_parts = [piece for piece in parsed.path.split("/") if piece]
        return clean_youtube_id(path_parts[0] if path_parts else "")

    if host.endswith("youtube.com") or host.endswith("youtube-nocookie.com"):
        by_query = clean_youtube_id(parse_qs(parsed.query).get("v", [""])[0])
        if by_query:
            return by_query
        path_parts = [piece for piece in parsed.path.split("/") if piece]
        if path_parts[:1] and path_parts[0] in {"shorts", "embed", "live", "v"} and len(path_parts) > 1:
            return clean_youtube_id(path_parts[1])

    return ""


def clean_youtube_id(value: str) -> str:
    candidate = str(value or "").strip().split("?")[0].split("&")[0].split("#")[0].split("/")[0]
    return candidate if re.fullmatch(r"[A-Za-z0-9_-]{11}", candidate) else ""


def canonical_youtube_url(youtube_id: str) -> str:
    return f"https://www.youtube.com/watch?v={youtube_id}"


def norm_entry(raw: Any) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    entry_id = clean_entry_id(raw.get("entry_id") or raw.get("id"))
    title = clean_text(raw.get("title"), 120)
    artist = clean_text(raw.get("artist"), 120)
    youtube_id = youtube_id_from_any(raw.get("youtube_id") or raw.get("youtube_url"))
    youtube_url = canonical_youtube_url(youtube_id) if youtube_id else ""
    pubkey = norm_pk(raw.get("pubkey") or "")
    user = norm_name(raw.get("user") or "seed")
    created_at = unix_or(raw.get("created_at"), now_sec())
    if not entry_id or not title or not artist:
        return None
    return {
        "entry_id": entry_id,
        "title": title,
        "artist": artist,
        "youtube_id": youtube_id,
        "youtube_url": youtube_url,
        "pubkey": pubkey if is_hex64(pubkey) else "",
        "user": user,
        "created_at": created_at,
    }


def fetch_relay_events(relay: str, filter_obj: dict[str, Any]) -> tuple[list[dict[str, Any]], RelayFetchResult]:
    from websocket import WebSocketTimeoutException, create_connection

    sub_id = f"nk3-rank-{int(time.time() * 1000):x}"
    events: list[dict[str, Any]] = []
    deadline = time.monotonic() + 12
    ws = None
    try:
        ws = create_connection(relay, timeout=8)
        ws.send(json.dumps(["REQ", sub_id, filter_obj]))
        while time.monotonic() < deadline:
            remaining = max(0.5, deadline - time.monotonic())
            ws.settimeout(remaining)
            try:
                raw = ws.recv()
            except WebSocketTimeoutException:
                break
            if not raw:
                break
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(msg, list) or not msg:
                continue
            if msg[0] == "EVENT" and len(msg) >= 3 and msg[1] == sub_id and isinstance(msg[2], dict):
                events.append(msg[2])
            elif msg[0] == "EOSE" and len(msg) >= 2 and msg[1] == sub_id:
                break
        return events, RelayFetchResult(relay=relay, ok=True, event_count=len(events), note="ok")
    except Exception as exc:  # noqa: BLE001
        return [], RelayFetchResult(relay=relay, ok=False, event_count=0, note=str(exc))
    finally:
        if ws is not None:
            try:
                ws.send(json.dumps(["CLOSE", sub_id]))
            except Exception:
                pass
            try:
                ws.close()
            except Exception:
                pass


def fetch_events(relays: list[str], event_limit: int) -> tuple[dict[str, dict[str, Any]], list[RelayFetchResult]]:
    filter_obj = {
        "kinds": [
            KIND_ENTRY,
            KIND_VOTE,
            KIND_MOD,
            KIND_SNAPSHOT,
            KIND_ADMIN_CLAIM,
            KIND_ADMIN_ROLE,
            KIND_USER_MOD,
            KIND_NAME_CLAIM,
        ],
        "#t": [APP_TAG],
        "limit": max(100, min(20000, int(event_limit))),
    }

    merged: dict[str, dict[str, Any]] = {}
    results: list[RelayFetchResult] = []
    for relay in relays:
        print(f"Querying {relay} ...")
        relay_events, result = fetch_relay_events(relay, filter_obj)
        for event in relay_events:
            event_id = str(event.get("id") or "")
            if event_id:
                merged[event_id] = event
        results.append(result)
        label = "ok" if result.ok else "fail"
        print(f"  {label}: {result.event_count} events")
    return merged, results


def apply_admin_claim(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    pubkey = norm_pk(payload.get("admin_pubkey") or first_tag(event, "admin"))
    if not is_hex64(pubkey) or norm_pk(event.get("pubkey")) != pubkey:
        return
    state.admin_claims.append(
        {
            "event": event,
            "pubkey": pubkey,
            "claimed_at": unix_or(payload.get("claimed_at") or first_tag(event, "version"), unix_or(event.get("created_at"), 0)),
        }
    )


def apply_admin_role(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    action = "grant" if payload.get("action") == "grant" else "revoke" if payload.get("action") == "revoke" else ""
    target_pubkey = norm_pk(payload.get("target_pubkey") or first_tag(event, "p"))
    if not action or not is_hex64(target_pubkey):
        return
    state.admin_role_events.append(
        {
            "event": event,
            "pubkey": norm_pk(event.get("pubkey")),
            "target_pubkey": target_pubkey,
            "action": action,
            "created_at": unix_or(event.get("created_at"), 0),
            "id": str(event.get("id") or ""),
        }
    )


def apply_user_mod(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    raw_action = str(payload.get("action") or "")
    action = raw_action if raw_action in {"ban", "temp_ban", "unban"} else ""
    target_pubkey = norm_pk(payload.get("target_pubkey") or first_tag(event, "p"))
    until_ts = unix_or(payload.get("until_ts") or first_tag(event, "until"), 0)
    if not action or not is_hex64(target_pubkey):
        return
    state.user_mod_events.append(
        {
            "event": event,
            "pubkey": norm_pk(event.get("pubkey")),
            "target_pubkey": target_pubkey,
            "action": action,
            "until_ts": until_ts,
            "created_at": unix_or(event.get("created_at"), 0),
            "id": str(event.get("id") or ""),
        }
    )


def apply_name_claim(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    name = norm_name(payload.get("name") or first_tag(event, "name"))
    if not name:
        return
    state.name_claim_events.append(
        {
            "event": event,
            "pubkey": norm_pk(event.get("pubkey")),
            "name": name,
            "created_at": unix_or(event.get("created_at"), 0),
            "id": str(event.get("id") or ""),
        }
    )


def apply_entry(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    entry_id = clean_entry_id(payload.get("entry_id") or first_tag(event, "d"))
    title = clean_text(payload.get("title"), 120)
    artist = clean_text(payload.get("artist"), 120)
    youtube_id = youtube_id_from_any(payload.get("youtube_id") or payload.get("youtube_url") or first_tag(event, "yt"))
    youtube_url = canonical_youtube_url(youtube_id) if youtube_id else ""
    user = norm_name(payload.get("user") or "")
    signer = norm_pk(event.get("pubkey"))
    created_at = unix_or(payload.get("created_at"), unix_or(event.get("created_at"), 0))
    if not entry_id or not title or not artist:
        return
    if user:
        remember_name(state, signer, user, unix_or(event.get("created_at"), 0))

    claimed_owner = norm_pk(payload.get("owner_pubkey") or first_tag(event, "p"))
    owner_candidate = claimed_owner if is_hex64(claimed_owner) else signer
    owner_name_candidate = norm_name(payload.get("owner_name") or "") or user or resolve_name(state, owner_candidate)
    owner = remember_entry_owner(state, entry_id, owner_candidate, owner_name_candidate, created_at, str(event.get("id") or ""))
    owner_pubkey = owner["pubkey"] if owner else owner_candidate
    owner_name = owner["user"] if owner else user or resolve_name(state, owner_pubkey)

    current = state.entries.get(entry_id)
    event_created_at = unix_or(event.get("created_at"), 0)
    event_id = str(event.get("id") or "")
    if current:
        current_created_at = current.get("event_created_at", 0)
        current_event_id = str(current.get("event_id") or "")
        if current_created_at > event_created_at or (current_created_at == event_created_at and current_event_id >= event_id):
            if current.get("pubkey") != owner_pubkey or current.get("user") != owner_name:
                state.entries[entry_id] = {**current, "pubkey": owner_pubkey, "user": owner_name}
            return

    state.entries[entry_id] = {
        "entry_id": entry_id,
        "title": title,
        "artist": artist,
        "youtube_id": youtube_id,
        "youtube_url": youtube_url,
        "user": owner_name,
        "created_at": created_at,
        "pubkey": owner_pubkey,
        "event_created_at": event_created_at,
        "event_id": event_id,
    }


def apply_vote(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    entry_id = clean_entry_id(payload.get("entry_id") or first_tag(event, "d"))
    if not entry_id:
        return
    value = clamp_vote(payload.get("value"))
    user = norm_name(payload.get("user") or "")
    if user:
        remember_name(state, norm_pk(event.get("pubkey")), user, unix_or(event.get("created_at"), 0))
    by_entry = state.votes.setdefault(entry_id, {})
    pubkey = norm_pk(event.get("pubkey"))
    current = by_entry.get(pubkey)
    event_created_at = unix_or(event.get("created_at"), 0)
    if current and current.get("event_created_at", 0) > event_created_at:
        return
    by_entry[pubkey] = {"value": value, "user": user, "event_created_at": event_created_at}


def apply_mod(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    entry_id = clean_entry_id(payload.get("entry_id") or first_tag(event, "d"))
    raw_action = str(payload.get("action") or "")
    action = raw_action if raw_action in {"restore", "revoke"} else ""
    if not entry_id or not action:
        return
    state.mod_events.append(
        {
            "entry_id": entry_id,
            "action": action,
            "pubkey": norm_pk(event.get("pubkey")),
            "created_at": unix_or(event.get("created_at"), 0),
            "id": str(event.get("id") or ""),
        }
    )


def apply_snapshot(state: State, event: dict[str, Any]) -> None:
    payload = parse_obj(event.get("content"))
    if not payload:
        return
    raw_entries = payload.get("entries")
    if not isinstance(raw_entries, list):
        return
    version_ts = unix_or(payload.get("version_ts") or first_tag(event, "version"), unix_or(event.get("created_at"), 0))
    admin_pubkey = norm_pk(payload.get("admin_pubkey") or "")
    dedupe: dict[str, dict[str, Any]] = {}
    for raw_entry in raw_entries:
        entry = norm_entry(raw_entry)
        if entry:
            dedupe[entry["entry_id"]] = entry
    entries = list(dedupe.values())
    for entry in entries:
        if is_hex64(norm_pk(entry.get("pubkey") or "")):
            remember_entry_owner(
                state,
                entry["entry_id"],
                norm_pk(entry["pubkey"]),
                norm_name(entry.get("user") or ""),
                unix_or(entry.get("created_at"), now_sec()),
                str(event.get("id") or ""),
            )
    state.snapshot_events.append(
        {
            "event": event,
            "version_ts": version_ts,
            "admin_pubkey": admin_pubkey,
            "entries": entries,
        }
    )


def ingest_events(events: list[dict[str, Any]]) -> State:
    state = State()
    ordered = sorted(
        [event for event in events if isinstance(event, dict) and has_tag(event, "t", APP_TAG)],
        key=lambda event: (unix_or(event.get("created_at"), 0), str(event.get("id") or "")),
    )
    for event in ordered:
        kind = int(event.get("kind") or 0)
        if kind == KIND_ADMIN_CLAIM:
            apply_admin_claim(state, event)
        elif kind == KIND_ADMIN_ROLE:
            apply_admin_role(state, event)
        elif kind == KIND_USER_MOD:
            apply_user_mod(state, event)
        elif kind == KIND_NAME_CLAIM:
            apply_name_claim(state, event)
        elif kind == KIND_ENTRY:
            apply_entry(state, event)
        elif kind == KIND_VOTE:
            apply_vote(state, event)
        elif kind == KIND_MOD:
            apply_mod(state, event)
        elif kind == KIND_SNAPSHOT:
            apply_snapshot(state, event)

    recompute_name_claims(state)
    recompute_admin(state)
    return state


def recompute_name_claims(state: State) -> None:
    by_name: dict[str, dict[str, Any]] = {}
    ordered = sorted(state.name_claim_events, key=lambda claim: (claim["created_at"], claim["id"]))
    for claim in ordered:
        by_name.setdefault(
            claim["name"],
            {
                "name": claim["name"],
                "pubkey": claim["pubkey"],
                "created_at": claim["created_at"],
                "id": claim["id"],
            },
        )

    by_pub_info: dict[str, dict[str, Any]] = {}
    for claim in ordered:
        owner = by_name.get(claim["name"])
        if not owner or owner["pubkey"] != claim["pubkey"]:
            continue
        current = by_pub_info.get(claim["pubkey"])
        newer = (
            current is None
            or claim["created_at"] > current["created_at"]
            or (claim["created_at"] == current["created_at"] and claim["id"] > current["id"])
        )
        if newer:
            by_pub_info[claim["pubkey"]] = {
                "name": claim["name"],
                "created_at": claim["created_at"],
                "id": claim["id"],
            }

    state.name_owner_by_name = by_name
    state.name_by_pubkey = {pubkey: info["name"] for pubkey, info in by_pub_info.items()}


def recompute_admin(state: State) -> None:
    sorted_claims = sorted(
        state.admin_claims,
        key=lambda claim: (claim["claimed_at"], unix_or(claim["event"].get("created_at"), 0), str(claim["event"].get("id") or "")),
    )
    if sorted_claims:
        state.admin = {"pubkey": sorted_claims[0]["pubkey"], "claim_event": sorted_claims[0]["event"]}
    else:
        state.admin = {"pubkey": "", "claim_event": None}

    admins: set[str] = set()
    if is_hex64(state.admin["pubkey"]):
        admins.add(state.admin["pubkey"])

    for role in sorted(state.admin_role_events, key=lambda item: (item["created_at"], item["id"])):
        if role["pubkey"] not in admins:
            continue
        if role["action"] == "grant":
            admins.add(role["target_pubkey"])
        elif role["action"] == "revoke" and role["target_pubkey"] != state.admin["pubkey"]:
            admins.discard(role["target_pubkey"])

    state.admins = admins
    recompute_snapshot_choice(state)
    recompute_user_bans(state)
    recompute_mods(state)


def recompute_snapshot_choice(state: State) -> None:
    winner = None
    if is_hex64(state.admin["pubkey"]):
        for snapshot in state.snapshot_events:
            signer = norm_pk(snapshot["event"].get("pubkey"))
            if signer not in state.admins:
                continue
            if snapshot["admin_pubkey"] and snapshot["admin_pubkey"] != state.admin["pubkey"]:
                continue
            if winner is None:
                winner = snapshot
                continue
            current_created_at = unix_or(snapshot["event"].get("created_at"), 0)
            winner_created_at = unix_or(winner["event"].get("created_at"), 0)
            current_id = str(snapshot["event"].get("id") or "")
            winner_id = str(winner["event"].get("id") or "")
            newer = (
                snapshot["version_ts"] > winner["version_ts"]
                or (
                    snapshot["version_ts"] == winner["version_ts"]
                    and (
                        current_created_at > winner_created_at
                        or (current_created_at == winner_created_at and current_id > winner_id)
                    )
                )
            )
            if newer:
                winner = snapshot
    if winner is None:
        state.snapshot = None
    else:
        state.snapshot = {
            "event_id": str(winner["event"].get("id") or ""),
            "version_ts": winner["version_ts"],
            "entries": winner["entries"],
        }


def is_pubkey_admin(state: State, pubkey: str) -> bool:
    return norm_pk(pubkey) in state.admins


def owner_pubkey_for_entry(state: State, entry_id: str) -> str:
    clean_id = clean_entry_id(entry_id)
    owned = state.entry_owners.get(clean_id)
    if owned and is_hex64(norm_pk(owned.get("pubkey") or "")):
        return norm_pk(owned["pubkey"])
    live = state.entries.get(clean_id)
    if live and is_hex64(norm_pk(live.get("pubkey") or "")):
        return norm_pk(live["pubkey"])
    if state.snapshot and isinstance(state.snapshot.get("entries"), list):
        for item in state.snapshot["entries"]:
            if item.get("entry_id") != clean_id:
                continue
            pubkey = norm_pk(item.get("pubkey") or "")
            if is_hex64(pubkey):
                return pubkey
            break
    return ""


def can_pubkey_moderate_entry(state: State, pubkey: str, entry_id: str) -> bool:
    clean_pubkey = norm_pk(pubkey)
    if not is_hex64(clean_pubkey):
        return False
    if is_pubkey_admin(state, clean_pubkey):
        return True
    owner = owner_pubkey_for_entry(state, entry_id)
    return bool(owner and owner == clean_pubkey)


def recompute_mods(state: State) -> None:
    next_mods: dict[str, dict[str, Any]] = {}
    for item in state.mod_events:
        if not can_pubkey_moderate_entry(state, item["pubkey"], item["entry_id"]):
            continue
        current = next_mods.get(item["entry_id"])
        if current is None or item["created_at"] > current["created_at"] or (
            item["created_at"] == current["created_at"] and item["id"] > current["id"]
        ):
            next_mods[item["entry_id"]] = item
    state.mods = next_mods


def recompute_user_bans(state: State) -> None:
    bans: dict[str, dict[str, Any]] = {}
    now = now_sec()
    for event in sorted(state.user_mod_events, key=lambda item: (item["created_at"], item["id"])):
        if not is_pubkey_admin(state, event["pubkey"]):
            continue
        if event["action"] == "unban":
            bans.pop(event["target_pubkey"], None)
            continue
        if event["action"] == "temp_ban":
            if not event["until_ts"] or event["until_ts"] <= now:
                bans.pop(event["target_pubkey"], None)
                continue
            bans[event["target_pubkey"]] = {
                "action": "temp_ban",
                "until_ts": event["until_ts"],
                "created_at": event["created_at"],
                "id": event["id"],
            }
            continue
        bans[event["target_pubkey"]] = {
            "action": "ban",
            "until_ts": 0,
            "created_at": event["created_at"],
            "id": event["id"],
        }
    state.user_bans = bans


def active_ban_for_pubkey(state: State, pubkey: str) -> dict[str, Any] | None:
    clean_pubkey = norm_pk(pubkey)
    if not is_hex64(clean_pubkey):
        return None
    ban = state.user_bans.get(clean_pubkey)
    if not ban:
        return None
    if ban.get("until_ts", 0) and ban["until_ts"] <= now_sec():
        return None
    return ban


def owner_pubkey_for_name(state: State, name: str) -> str:
    owner = state.name_owner_by_name.get(norm_name(name))
    return owner["pubkey"] if owner else ""


def uniq_names(values: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for value in values:
        clean = norm_name(value)
        if not clean or clean in seen:
            continue
        seen.add(clean)
        out.append(clean)
    return out


def build_rows(state: State) -> list[dict[str, Any]]:
    merged: dict[str, dict[str, Any]] = {}
    base_entries = state.snapshot["entries"] if state.snapshot and state.snapshot.get("entries") else DEFAULT_SNAPSHOT
    for entry in base_entries:
        normalized = norm_entry(entry)
        if normalized:
            merged[normalized["entry_id"]] = normalized
    for entry_id, entry in state.entries.items():
        merged[entry_id] = entry

    rows: list[dict[str, Any]] = []
    for entry in merged.values():
        owner_pubkey = norm_pk(entry.get("pubkey") or "")
        owner_banned = bool(owner_pubkey and active_ban_for_pubkey(state, owner_pubkey))
        mod = state.mods.get(entry["entry_id"])
        revoked = bool(mod and mod.get("action") == "revoke")
        if revoked or owner_banned:
            continue

        by_entry = state.votes.get(entry["entry_id"], {})
        score = 0
        upvoters: list[str] = []
        for pubkey, vote in by_entry.items():
            if active_ban_for_pubkey(state, pubkey):
                continue
            score += vote["value"]
            if vote["value"] > 0:
                upvoters.append(vote["user"] or resolve_name(state, pubkey))

        rows.append(
            {
                **entry,
                "owner_pubkey": owner_pubkey,
                "owner_banned": owner_banned,
                "revoked": revoked,
                "score": score,
                "upvoters": uniq_names(upvoters),
            }
        )

    rows.sort(key=lambda row: (-row["score"], -int(row["created_at"]), row["title"].lower()))
    for index, row in enumerate(rows, start=1):
        row["rank"] = index
    return rows


def write_exports(download_dir: Path, rows: list[dict[str, Any]], relay_results: list[RelayFetchResult], alias: str, pubkey: str) -> tuple[Path, Path, Path]:
    download_dir.mkdir(parents=True, exist_ok=True)
    manifest_json = download_dir / "ranked-list.json"
    manifest_txt = download_dir / "ranked-list.txt"
    url_list = download_dir / "youtube-urls.txt"

    payload = {
        "generated_at": now_sec(),
        "alias": alias,
        "pubkey": pubkey,
        "app_tag": APP_TAG,
        "rows": rows,
        "relays": [
            {
                "relay": result.relay,
                "ok": result.ok,
                "event_count": result.event_count,
                "note": result.note,
            }
            for result in relay_results
        ],
    }
    manifest_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")

    txt_lines: list[str] = []
    url_lines: list[str] = []
    for row in rows:
        youtube_url = row.get("youtube_url") or ""
        if youtube_url:
            url_lines.append(youtube_url)
        txt_lines.append(
            f"{row['rank']:03d} | {row['score']:+d} | {row['artist']} - {row['title']} | by @{row['user']} | {youtube_url or 'no-youtube'}"
        )
    manifest_txt.write_text("\n".join(txt_lines) + ("\n" if txt_lines else ""), encoding="utf-8")
    url_list.write_text("\n".join(url_lines) + ("\n" if url_lines else ""), encoding="utf-8")
    return manifest_json, manifest_txt, url_list


def prompt_confirm(message: str, default_yes: bool = True) -> bool:
    suffix = "[Y/n]" if default_yes else "[y/N]"
    reply = input(f"{message} {suffix} ").strip().lower()
    if not reply:
        return default_yes
    return reply in {"y", "yes"}


def ffmpeg_names() -> tuple[str, str]:
    if os.name == "nt":
        return "ffmpeg.exe", "ffprobe.exe"
    return "ffmpeg", "ffprobe"


def find_portable_ffmpeg_bin_dir() -> Path | None:
    ffmpeg_name, ffprobe_name = ffmpeg_names()
    if not FFMPEG_DIR.exists():
        return None

    candidates: list[Path] = []
    for ffmpeg_path in FFMPEG_DIR.rglob(ffmpeg_name):
        bin_dir = ffmpeg_path.parent
        if (bin_dir / ffprobe_name).exists():
            candidates.append(bin_dir)
    if not candidates:
        return None
    candidates.sort(key=lambda path: (len(path.parts), len(str(path))))
    return candidates[0]


def current_platform_ffmpeg_preferences() -> tuple[list[str], list[str]]:
    system = platform.system().lower()
    machine = platform.machine().lower()
    is_arm = "arm" in machine or "aarch" in machine
    is_64 = machine.endswith("64") or machine in {"amd64", "x86_64"}

    if system == "windows":
        arch_tokens = ["winarm64", "win64"] if is_arm else ["win64", "win32"] if is_64 else ["win32"]
        return arch_tokens, [".zip"]
    if system == "linux":
        arch_tokens = ["linuxarm64", "linux64"] if is_arm else ["linux64", "linux32"] if is_64 else ["linux32"]
        return arch_tokens, [".tar.xz", ".tar.gz"]
    if system == "darwin":
        arch_tokens = ["macosarm64", "mac-arm64"] if is_arm else ["macos64", "macosx64", "mac-x64"]
        return arch_tokens, [".zip", ".tar.xz"]
    raise RuntimeError(f"portable ffmpeg is not configured for {system}/{machine}")


def select_portable_ffmpeg_asset(assets: list[dict[str, Any]]) -> dict[str, Any]:
    arch_tokens, suffixes = current_platform_ffmpeg_preferences()
    fallback_tokens = ["shared", "static", "lgpl", "gpl", "latest"]

    def score_asset(asset: dict[str, Any]) -> int:
        name = str(asset.get("name") or "").lower()
        if not name or any(token in name for token in ("sha256", "checksum", ".sig", ".asc", "sources", "source")):
            return -1

        suffix_score = -1
        for index, suffix in enumerate(suffixes):
            if name.endswith(suffix):
                suffix_score = 50 - index
                break
        if suffix_score < 0:
            return -1

        arch_score = -1
        for index, token in enumerate(arch_tokens):
            if token in name:
                arch_score = 100 - (index * 10)
                break
        if arch_score < 0:
            return -1

        score = arch_score + suffix_score
        for index, token in enumerate(fallback_tokens):
            if token in name:
                score += 10 - index
        if "master" in name or "latest" in name:
            score += 15
        return score

    ranked_assets = sorted(assets, key=score_asset, reverse=True)
    if not ranked_assets or score_asset(ranked_assets[0]) < 0:
        system = platform.system().lower()
        machine = platform.machine().lower()
        raise RuntimeError(f"no portable ffmpeg asset found for {system}/{machine}")
    return ranked_assets[0]


def download_url_to_path(url: str, dest_path: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "NK3Mixtape downloader",
            "Accept": "application/octet-stream, application/json;q=0.9, */*;q=0.1",
        },
    )
    with urllib.request.urlopen(request) as response, dest_path.open("wb") as handle:
        shutil.copyfileobj(response, handle)


def ensure_safe_extract_member(target_root: Path, member_name: str) -> None:
    candidate = (target_root / member_name).resolve()
    if os.path.commonpath([str(target_root), str(candidate)]) != str(target_root):
        raise RuntimeError(f"unsafe archive path: {member_name}")


def extract_archive(archive_path: Path, target_root: Path) -> None:
    target_root_resolved = target_root.resolve()
    if archive_path.name.endswith(".zip"):
        with zipfile.ZipFile(archive_path) as archive:
            for member in archive.namelist():
                ensure_safe_extract_member(target_root_resolved, member)
            archive.extractall(target_root_resolved)
        return

    with tarfile.open(archive_path, "r:*") as archive:
        for member in archive.getnames():
            ensure_safe_extract_member(target_root_resolved, member)
        archive.extractall(target_root_resolved)


def install_portable_ffmpeg() -> Path:
    print("Fetching portable ffmpeg release metadata...")
    request = urllib.request.Request(
        FFMPEG_RELEASE_API,
        headers={
            "User-Agent": "NK3Mixtape downloader",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(request) as response:
        release = json.loads(response.read().decode("utf-8"))

    asset = select_portable_ffmpeg_asset(list(release.get("assets") or []))
    archive_name = str(asset.get("name") or "ffmpeg-archive")
    archive_url = str(asset.get("browser_download_url") or "")
    if not archive_url:
        raise RuntimeError("portable ffmpeg release asset is missing a download URL")

    print(f"Downloading portable ffmpeg: {archive_name}")
    TOOLS_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = TOOLS_DIR / archive_name
    if FFMPEG_DIR.exists():
        shutil.rmtree(FFMPEG_DIR)
    FFMPEG_DIR.mkdir(parents=True, exist_ok=True)

    try:
        download_url_to_path(archive_url, archive_path)
        print(f"Extracting portable ffmpeg into {FFMPEG_DIR}")
        extract_archive(archive_path, FFMPEG_DIR)
    finally:
        archive_path.unlink(missing_ok=True)

    bin_dir = find_portable_ffmpeg_bin_dir()
    if bin_dir is None:
        raise RuntimeError("portable ffmpeg was downloaded but ffmpeg/ffprobe were not found after extraction")
    return bin_dir


def resolve_ffmpeg_location() -> tuple[Path | None, str]:
    system_ffmpeg = shutil.which("ffmpeg")
    if system_ffmpeg:
        return None, system_ffmpeg

    print("ffmpeg is not on PATH. Checking for a repo-local portable copy...")
    local_bin_dir = find_portable_ffmpeg_bin_dir()
    if local_bin_dir is not None:
        return local_bin_dir, f"portable ({local_bin_dir})"

    print(f"No portable ffmpeg found under {FFMPEG_DIR}.")
    print(f"Attempting to download a portable copy into {FFMPEG_DIR} for mp3 conversion...")

    try:
        bin_dir = install_portable_ffmpeg()
    except Exception as exc:
        print(f"Portable ffmpeg install failed after checking PATH and local cache: {exc}")
        print("Falling back to source audio formats because mp3 conversion could not be set up.")
        return None, ""
    return bin_dir, f"portable ({bin_dir})"


def download_audio(rows: list[dict[str, Any]], download_dir: Path) -> None:
    import yt_dlp

    archive_path = download_dir / ".yt-dlp-archive.txt"
    cache_dir = TOOLS_DIR / "yt-dlp-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    rank_width = max(3, len(str(max((int(row.get("rank") or 0) for row in rows), default=0))))
    ffmpeg_location, ffmpeg_note = resolve_ffmpeg_location()
    ffmpeg_available = shutil.which("ffmpeg") is not None or ffmpeg_location is not None

    if ffmpeg_available:
        print(f"ffmpeg ready via {ffmpeg_note or 'PATH'}: downloading and transcoding to mp3.")
    else:
        print("ffmpeg not found: downloading original best-audio formats instead of mp3.")

    options: dict[str, Any] = {
        "format": "bestaudio/best",
        "ignoreerrors": True,
        "download_archive": str(archive_path),
        "windowsfilenames": True,
        "cachedir": str(cache_dir),
        "noplaylist": True,
    }
    if ffmpeg_available:
        if ffmpeg_location is not None:
            options["ffmpeg_location"] = str(ffmpeg_location)
        options["postprocessors"] = [
            {
                "key": "FFmpegExtractAudio",
                "preferredcodec": "mp3",
                "preferredquality": "192",
            }
        ]

    for index, row in enumerate(rows, start=1):
        label = f"[{index:03d}/{len(rows):03d}] {row['score']:+d} {row['artist']} - {row['title']}"
        print(label)
        rank_prefix = f"{int(row.get('rank') or index):0{rank_width}d}"
        artist_part = clean_filename(row.get("artist") or "Unknown Artist", 120)
        title_part = clean_filename(row.get("title") or "Untitled", 120)
        row_options = dict(options)
        row_options["outtmpl"] = str(download_dir / f"{rank_prefix} - {artist_part} - {title_part}.%(ext)s")
        with yt_dlp.YoutubeDL(row_options) as ydl:
            ydl.download([row["youtube_url"]])


def main() -> int:
    args = parse_args()
    ensure_python_deps()

    alias = norm_name(args.alias or input("Alias: "))
    if not alias:
        raise SystemExit("alias required")
    passphrase = getpass.getpass("Password: ").strip()
    if not passphrase:
        raise SystemExit("password required")

    relays = args.relay[:] if args.relay else DEFAULT_RELAYS[:]
    download_dir = Path(args.download_dir).resolve()

    print("Deriving key...")
    secret_key = derive_secret_key(passphrase)
    pubkey = secret_key_to_pubkey(secret_key)

    print("Fetching current playlist state...")
    events, relay_results = fetch_events(relays, args.event_limit)
    if not events:
        raise SystemExit("no playlist events found from the configured relays")

    state = ingest_events(list(events.values()))
    name_owner = owner_pubkey_for_name(state, alias)
    if name_owner and name_owner != pubkey:
        legacy_secret = derive_legacy_secret_key(passphrase, alias)
        legacy_pubkey = secret_key_to_pubkey(legacy_secret)
        if legacy_pubkey == name_owner:
            secret_key = legacy_secret
            pubkey = legacy_pubkey
        else:
            raise SystemExit(f"wrong password for @{alias}")

    print(f"Signed in as @{alias} ({short_pk(pubkey)})")

    rows = build_rows(state)
    youtube_rows = [row for row in rows if row.get("youtube_url")]
    if args.top and args.top > 0:
        youtube_rows = youtube_rows[:args.top]

    manifest_json, manifest_txt, url_list = write_exports(download_dir, rows, relay_results, alias, pubkey)
    print(f"Exported ranked list to {manifest_json}")
    print(f"Exported readable list to {manifest_txt}")
    print(f"Exported YouTube URLs to {url_list}")
    print(f"Visible songs: {len(rows)}")
    print(f"YouTube-backed songs: {len([row for row in rows if row.get('youtube_url')])}")
    if args.top and args.top > 0:
        print(f"Download selection: top {len(youtube_rows)}")

    if args.list_only:
        return 0

    if not youtube_rows:
        print("No YouTube-backed songs to download.")
        return 0

    if not args.yes and not prompt_confirm(f"Download {len(youtube_rows)} songs into {download_dir}?", default_yes=True):
        print("Download skipped.")
        return 0

    download_audio(youtube_rows, download_dir)
    print(f"Done. Files and manifests are under {download_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
