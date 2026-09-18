"""JARVIS Control Center dashboard routes.

These routes aggregate machine-local Hermes state with Enrique's read-only
Windows PC bridge. The browser never receives the PC bridge token and never
calls the bridge directly.
"""

from __future__ import annotations

import json
import os
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Literal, Optional, Tuple

from fastapi import APIRouter, Request

router = APIRouter()

_PC_BRIDGE_BASE = "http://127.0.0.1:8765"
_PC_BRIDGE_TOKEN_PATH = Path.home() / ".hermes" / "pc_bridge_token"
_PC_TIMEOUT_S = 3.0
_PROJECT_CACHE_TTL_S = 60.0
_BRIDGE_CACHE_TTL_S = 10.0

# --- Spend / model / expenses (left rail) -----------------------------------
# The browser never gets the Fireworks key: everything below is computed
# server-side and only the resulting dollar figures are returned.
_HERMES_HOME = Path.home() / ".hermes"
_ENV_PATH = _HERMES_HOME / ".env"
_CONFIG_PATH = _HERMES_HOME / "config.yaml"
_STATE_DB_PATH = _HERMES_HOME / "state.db"
_FW_API_BASE = "https://api.fireworks.ai/v1"
_FW_TIMEOUT_S = 6.0
_SPEND_CACHE_TTL_S = 300.0
_ACTIVITY_CACHE_TTL_S = 5.0

# Z.AI GLM Coding Plan usage (the primary model runs on this flat plan now).
# The monitor endpoint reports the 5-hour + weekly credit windows; auth is the
# ZAI_API_KEY passed RAW in Authorization (no "Bearer" prefix). Not a completion
# call, so polling it does not consume plan quota.
_ZAI_MONITOR_URL = "https://api.z.ai/api/monitor/usage/quota/limit"
_ZAI_TIMEOUT_S = 8.0
_ZAI_CACHE_TTL_S = 30.0

# Fireworks serverless price, USD per 1M tokens: (input, cached_input, output).
# CACHED input is billed far cheaper than fresh input and dominates our usage
# (most prompt tokens are prompt-cache hits), so it must be priced separately.
# These rates are CALIBRATED against the real Fireworks billing dashboard
# (2026-09-04): multiplying them by the billing API's uncached/cached/output
# token counts reproduces the invoiced per-model dollars (~$5.3 total) to the
# cent. Cached ≈ 20% of input for GLM/DeepSeek/Qwen; Kimi cached is a flat
# $0.16. Edit here if Fireworks changes prices.
FIREWORKS_PRICES: Dict[str, Tuple[float, float, float]] = {
    "glm-5p3-flash": (0.15, 0.03, 0.50),
    "glm-5p3": (1.40, 0.28, 4.40),
    "kimi-k2p6": (0.95, 0.16, 4.00),
    "kimi-k2p7-code": (0.95, 0.16, 4.00),
    "deepseek-v4-flash-0731": (0.22, 0.044, 0.66),
    "deepseek-v4-flash": (0.22, 0.044, 0.66),
    "gpt-oss-120b": (0.15, 0.03, 0.60),
    "qwen3p7-plus": (0.22, 0.044, 0.88),
    "glm-5p2": (0.60, 0.12, 2.20),
    "nemotron-lightning-3p5-30b-a3b": (0.15, 0.03, 0.60),
}
# Unknown model -> rough default so the total never silently drops usage.
FIREWORKS_PRICE_FALLBACK: Tuple[float, float, float] = (0.30, 0.06, 1.00)

# Recurring costs to run JARVIS. Each item is USD-native (`usd`) or converted
# from EUR (`eur` * fx). Add more subscriptions here as they come.
_EUR_USD_FX = 1.1627  # 2026-09-04; update with the EUR amounts below.
_EXPENSES: List[Dict[str, Any]] = [
    {"label": "Z.AI GLM Coding Plan (Lite)", "usd": 18.00, "period": "monthly"},
    {"label": "NetCup vServer (SCP)", "eur": 24.88, "period": "monthly"},
]
_EXPENSES_NOTE = "Model runs on the Z.AI plan; Fireworks is metered backup only."

DomainId = Literal["krendora", "ticketflipping", "system"]


@dataclass
class _CacheEntry:
    expires_at: float
    value: Any


_cache: Dict[str, _CacheEntry] = {}


PROJECT_ROOTS = [
    {
        "id": "ticketflipping",
        "label": "Ticketflipping",
        "domain": "ticketflipping",
        "path": r"C:\Users\Enrique\DEV",
        "source": "pc_bridge",
        "caution": "production",
        "accent": "amber",
        "description": "Professional Ticketflipping stack: Toolbox, Flare, Broker Copilot, scrapers.",
    },
    {
        "id": "krendora",
        "label": "Krendora / Personal",
        "domain": "krendora",
        "path": r"C:\Users\Enrique\DEV_personal",
        "source": "pc_bridge",
        "caution": "normal",
        "accent": "cyan",
        "description": "Personal projects including Krendora/AIDP and JARVIS workspaces.",
    },
    {
        "id": "system",
        "label": "System / Hermes",
        "domain": "system",
        "path": "/usr/local/lib/hermes-agent",
        "source": "local",
        "caution": "high",
        "accent": "violet",
        "description": "This Hermes Agent deployment and dashboard source.",
    },
]

PROJECT_SUMMARIES = {
    "broker-copilot-app": "Django customer-facing Broker Copilot app with Langflow integration.",
    "broker-copilot-prompts": "Broker Copilot prompt and Langflow configuration; deploy-sensitive.",
    "tftboxext": "Ticketflipping Toolbox Chrome extension; mature and revenue-critical.",
    "tfteventalerts": "Flare Django app and event-alert automation.",
    "tmapi": "Ticketflipping scraping/data engine and operational automation.",
    "AIDP": "AI drop-shipping automation; Krendora-related Shopify/general-store work.",
    "aidp-sync-pr": "AIDP operations, pipelines, and social automation snapshot.",
    "JARVIS": "Jarvis V1 core control plane and automation backend.",
    "JARVIS-V2": "Hermes-based Jarvis deployment workspace and runbooks.",
    "jarvis-control-center": "Jarvis control-center frontend workspace.",
    "jarvis-v2-frontend": "Jarvis command-map/frontend experiments.",
    "account-studio": "Account tooling workspace with Supabase/local sidecar architecture.",
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _cached(key: str) -> Optional[Any]:
    entry = _cache.get(key)
    if entry and entry.expires_at > time.monotonic():
        return entry.value
    return None


def _set_cached(key: str, value: Any, ttl: float) -> Any:
    _cache[key] = _CacheEntry(time.monotonic() + ttl, value)
    return value


def _read_token() -> Optional[str]:
    try:
        token = _PC_BRIDGE_TOKEN_PATH.read_text(encoding="utf-8").strip()
        return token or None
    except OSError:
        return None


def _bridge_get(endpoint: str, params: Optional[Dict[str, str]] = None, *, auth: bool = True) -> Dict[str, Any]:
    query = ""
    if params:
        query = "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(_PC_BRIDGE_BASE + endpoint + query)
    if auth:
        token = _read_token()
        if not token:
            raise RuntimeError("PC bridge token not configured")
        req.add_header("Authorization", f"Bearer {token}")
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=_PC_TIMEOUT_S) as resp:
            raw = resp.read(2_000_000)
            data = json.loads(raw.decode("utf-8", errors="replace"))
            data["_latency_ms"] = round((time.monotonic() - started) * 1000)
            return data
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"PC bridge HTTP {exc.code}") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        raise RuntimeError(str(exc)) from exc


def _bridge_status_uncached() -> Dict[str, Any]:
    configured = _read_token() is not None
    started = time.monotonic()
    try:
        data = _bridge_get("/health", auth=False)
        latency = data.get("_latency_ms") or round((time.monotonic() - started) * 1000)
        return {
            "configured": configured,
            "reachable": True,
            "host": data.get("host") or data.get("hostname"),
            "roots": data.get("roots") or [],
            "latency_ms": latency,
            "error": None,
            "last_checked_at": _now_iso(),
        }
    except Exception as exc:  # noqa: BLE001 — endpoint returns error state, not traceback
        return {
            "configured": configured,
            "reachable": False,
            "host": None,
            "roots": [],
            "latency_ms": None,
            "error": str(exc),
            "last_checked_at": _now_iso(),
        }


def get_bridge_status() -> Dict[str, Any]:
    cached = _cached("bridge_status")
    if cached is not None:
        return cached
    return _set_cached("bridge_status", _bridge_status_uncached(), _BRIDGE_CACHE_TTL_S)


def _safe_items(data: Dict[str, Any]) -> List[Dict[str, Any]]:
    items = data.get("items")
    if isinstance(items, list):
        return [item for item in items if isinstance(item, dict)]
    return []


def _list_pc_dir(path: str) -> List[Dict[str, Any]]:
    return _safe_items(_bridge_get("/list", {"path": path}))


def _marker_metadata(path: str) -> Dict[str, bool]:
    try:
        names = {str(item.get("name")) for item in _list_pc_dir(path)}
    except Exception:
        names = set()
    return {
        "readme": "README.md" in names or "readme.md" in {n.lower() for n in names},
        "claudeMd": "CLAUDE.md" in names,
        "agentsMd": "AGENTS.md" in names,
        "packageJson": "package.json" in names,
        "pyproject": "pyproject.toml" in names,
        "managePy": "manage.py" in names,
        "viteConfig": "vite.config.ts" in names or "vite.config.js" in names,
        "nextConfig": "next.config.ts" in names or "next.config.mjs" in names or "next.config.js" in names,
        "dockerfile": "Dockerfile" in names,
    }


def _classify_personal_project(name: str) -> str:
    lowered = name.lower()
    if lowered in {"aidp", "aidp-sync-pr"} or "aidp" in lowered or "krendora" in lowered:
        return "krendora"
    if lowered.startswith("jarvis"):
        return "system"
    return "personal"


def _project_from_pc_item(root: Dict[str, Any], item: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    if item.get("restricted"):
        return None
    if item.get("type") != "directory":
        return None
    name = str(item.get("name") or "").strip()
    if not name or name.startswith("."):
        return None
    root_path = str(root["path"])
    path = root_path.rstrip("\\/") + "\\" + name
    domain: DomainId = root["domain"]  # type: ignore[assignment]
    if root["id"] == "krendora":
        domain = _classify_personal_project(name)  # type: ignore[assignment]
    return {
        "id": f"{domain}/{name}",
        "name": name,
        "domain": domain,
        "source": "pc_bridge",
        "path": path,
        "kind": "workspace",
        "summary": PROJECT_SUMMARIES.get(name),
        "caution": root.get("caution", "normal"),
        "restricted": False,
        "detected": _marker_metadata(path),
        "last_seen_at": _now_iso(),
    }


def _system_projects() -> List[Dict[str, Any]]:
    base = "/usr/local/lib/hermes-agent"
    return [
        {
            "id": "system/hermes-agent",
            "name": "hermes-agent",
            "domain": "system",
            "source": "local",
            "path": base,
            "kind": "repo",
            "summary": "Live Hermes Agent backend, dashboard, gateway, tools, and plugins.",
            "caution": "high",
            "restricted": False,
            "detected": {
                "readme": Path(base, "README.md").exists(),
                "claudeMd": Path(base, "CLAUDE.md").exists(),
                "agentsMd": Path(base, "AGENTS.md").exists(),
                "packageJson": Path(base, "package.json").exists(),
                "pyproject": Path(base, "pyproject.toml").exists(),
                "managePy": False,
                "viteConfig": Path(base, "web", "vite.config.ts").exists(),
                "nextConfig": False,
                "dockerfile": Path(base, "Dockerfile").exists(),
            },
            "last_seen_at": _now_iso(),
        }
    ]


def discover_projects(refresh: bool = False) -> Dict[str, Any]:
    if not refresh:
        cached = _cached("projects")
        if cached is not None:
            return cached

    bridge = get_bridge_status()
    projects: List[Dict[str, Any]] = _system_projects()
    roots = [dict(root) for root in PROJECT_ROOTS]

    if bridge.get("reachable"):
        for root in PROJECT_ROOTS:
            if root.get("source") != "pc_bridge":
                continue
            try:
                items = _list_pc_dir(str(root["path"]))
                root_projects = [p for item in items if (p := _project_from_pc_item(root, item))]
                projects.extend(root_projects)
            except Exception as exc:  # noqa: BLE001
                for r in roots:
                    if r["id"] == root["id"]:
                        r["status"] = "partial"
                        r["error"] = str(exc)
                        break
    for r in roots:
        if "status" not in r:
            if r.get("source") == "pc_bridge":
                r["status"] = "online" if bridge.get("reachable") else "offline"
            else:
                r["status"] = "online"

    result = {"generated_at": _now_iso(), "bridge": bridge, "roots": roots, "projects": projects}
    return _set_cached("projects", result, _PROJECT_CACHE_TTL_S)


def _connector_summaries() -> List[Dict[str, Any]]:
    bridge = get_bridge_status()
    connectors = [
        {
            "id": "pc_bridge",
            "label": "Windows PC Bridge",
            "kind": "pc_bridge",
            "status": "connected" if bridge.get("reachable") else "error",
            "detail": bridge.get("host") or bridge.get("error") or "Read-only desktop bridge",
            "updated_at": bridge.get("last_checked_at"),
            "latency_ms": bridge.get("latency_ms"),
            "href": "/control",
        },
        {
            "id": "github",
            "label": "GitHub",
            "kind": "oauth",
            "status": "configured",
            "detail": "Credential helper configured server-side",
            "href": "/system",
        },
    ]
    return connectors


def _attention(projects_payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    bridge = projects_payload.get("bridge") or {}
    if not bridge.get("reachable"):
        items.append({
            "id": "pc_bridge_offline",
            "severity": "critical" if bridge.get("configured") else "warning",
            "title": "Windows PC bridge unavailable",
            "detail": bridge.get("error") or "Bridge is not reachable.",
            "source": "bridge",
        })
    items.append({
        "id": "ticketflipping_boundary",
        "severity": "info",
        "title": "Ticketflipping is high-caution",
        "detail": "Professional/customer-facing work stays isolated from Krendora and requires confirmation for future write/deploy actions.",
        "source": "project_boundary",
    })
    return items


@router.get("/api/control/bridge/status")
async def control_bridge_status():
    return get_bridge_status()


@router.get("/api/control/projects")
async def control_projects(domain: str = "all", refresh: bool = False):
    payload = discover_projects(refresh=refresh)
    if domain != "all":
        payload = dict(payload)
        payload["projects"] = [p for p in payload["projects"] if p.get("domain") == domain]
    return payload


@router.get("/api/control/connectors")
async def control_connectors():
    return {"generated_at": _now_iso(), "connectors": _connector_summaries()}


@router.get("/api/control/overview")
async def control_overview(refresh: bool = False):
    projects_payload = discover_projects(refresh=refresh)
    return {
        "generated_at": _now_iso(),
        "bridge": projects_payload.get("bridge"),
        "roots": projects_payload.get("roots", []),
        "projects": projects_payload.get("projects", []),
        "connectors": _connector_summaries(),
        "attention": _attention(projects_payload),
    }


# --- Spend + activity (left rail / current work) ----------------------------

def _env_value(name: str) -> Optional[str]:
    """Read a secret from the process env, falling back to ~/.hermes/.env.

    Never returned to the browser — only the numbers it lets us compute are.
    """
    val = os.environ.get(name)
    if val:
        return val.strip()
    try:
        for line in _ENV_PATH.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            if k.strip() == name:
                return v.strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def _current_model() -> Dict[str, str]:
    """Resolve the active model + provider from ~/.hermes/config.yaml."""
    name = "unknown"
    provider = "unknown"
    try:
        import yaml  # pyyaml ships with Hermes

        cfg = yaml.safe_load(_CONFIG_PATH.read_text(encoding="utf-8")) or {}
        model = cfg.get("model") or {}
        name = model.get("default") or model.get("name") or name
        provider = str(model.get("provider") or provider)
    except Exception:
        pass
    provider = provider.split(":")[-1]  # "custom:fireworks" -> "fireworks"
    low = provider.lower()
    if "zai" in low or "zhipu" in low or "glm" in low:
        provider = "Z.AI"
    elif "fireworks" in low:
        provider = "Fireworks"
    short = name.split("/")[-1] if name != "unknown" else name
    return {"name": name, "provider": provider, "short": short}


def _price_for(short_model: str) -> Tuple[Tuple[float, float, float], bool]:
    """Return (input, cached_input, output) USD/1M for a model + whether known."""
    if short_model in FIREWORKS_PRICES:
        return FIREWORKS_PRICES[short_model], True
    for key, price in FIREWORKS_PRICES.items():
        if short_model.startswith(key) or key.startswith(short_model):
            return price, True
    return FIREWORKS_PRICE_FALLBACK, False


def _fw_get(path: str, key: str, params: Optional[Dict[str, str]] = None) -> Any:
    url = f"{_FW_API_BASE}/{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {key}"})
    with urllib.request.urlopen(req, timeout=_FW_TIMEOUT_S) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _fireworks_account(key: str) -> Optional[Dict[str, Any]]:
    """First Fireworks account: {"name", "create_time"}, cached for an hour."""
    cached = _cached("fw_account")
    if cached is not None:
        return cached
    try:
        data = _fw_get("accounts", key)
        accounts = data.get("accounts") or []
        acc = accounts[0] if accounts else None
    except Exception:
        acc = None
    if acc and acc.get("name"):
        info = {"name": acc["name"], "create_time": acc.get("createTime")}
        _set_cached("fw_account", info, 3600.0)
        return info
    return None


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _expenses_block() -> Dict[str, Any]:
    items: List[Dict[str, Any]] = []
    total = 0.0
    for exp in _EXPENSES:
        if exp.get("usd") is not None:
            usd = round(float(exp["usd"]), 2)
            eur = None
            fx = None
        else:
            usd = round(float(exp["eur"]) * _EUR_USD_FX, 2)
            eur = exp["eur"]
            fx = _EUR_USD_FX
        total += usd
        items.append({
            "label": exp["label"],
            "eur": eur,
            "usd": usd,
            "fx": fx,
            "period": exp.get("period", "monthly"),
        })
    return {"monthly_total_usd": round(total, 2), "items": items, "note": _EXPENSES_NOTE}


def _zai_usage() -> Dict[str, Any]:
    """Z.AI GLM Coding Plan usage: the 5-hour and weekly credit windows.

    Uses the monitor endpoint, authed with the raw ZAI_API_KEY (no Bearer).
    Response `data.limits[]` items give currentValue (used), usage (limit),
    remaining, percentage, and nextResetTime (epoch ms). unit 3 == hours,
    unit 6 == week; we derive the window label from (number, unit).
    """
    cached = _cached("zai_usage")
    if cached is not None:
        return cached

    result: Dict[str, Any] = {
        "generated_at": _now_iso(),
        "available": False,
        "level": None,
        "windows": [],
        "error": None,
    }

    key = _env_value("ZAI_API_KEY")
    if not key:
        result["error"] = "no Z.AI key"
        return _set_cached("zai_usage", result, _ZAI_CACHE_TTL_S)

    try:
        req = urllib.request.Request(
            _ZAI_MONITOR_URL,
            headers={
                "Authorization": key,  # raw token, NOT "Bearer <key>"
                "Accept-Language": "en-US,en",
                "Content-Type": "application/json",
            },
        )
        with urllib.request.urlopen(req, timeout=_ZAI_TIMEOUT_S) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        payload = data.get("data") or {}
        now_ms = time.time() * 1000
        windows = []
        for lim in payload.get("limits") or []:
            unit = lim.get("unit")
            number = lim.get("number") or 0
            if unit == 3:
                key_id, label = "5h", f"{number}-hour"
            elif unit == 6:
                key_id, label = "weekly", ("weekly" if number == 1 else f"{number}-week")
            elif unit == 5:
                key_id, label = "daily", ("daily" if number == 1 else f"{number}-day")
            else:
                key_id, label = f"u{unit}n{number}", f"{number}·unit{unit}"
            reset_ms = lim.get("nextResetTime")
            reset_in = int((reset_ms - now_ms) / 1000) if reset_ms else None
            windows.append({
                "key": key_id,
                "label": label,
                "used": lim.get("currentValue"),
                "limit": lim.get("usage"),
                "remaining": lim.get("remaining"),
                "percent": lim.get("percentage"),
                "reset_at_ms": reset_ms,
                "reset_in_seconds": reset_in if (reset_in is None or reset_in > 0) else 0,
            })
        # 5h first, then weekly, then anything else.
        order = {"5h": 0, "daily": 1, "weekly": 2}
        windows.sort(key=lambda w: order.get(w["key"], 9))
        result.update({
            "available": True,
            "level": payload.get("level"),
            "windows": windows,
        })
    except Exception as exc:  # noqa: BLE001 - surface, don't crash the page
        result["error"] = str(exc)

    return _set_cached("zai_usage", result, _ZAI_CACHE_TTL_S)


def _fireworks_spend() -> Dict[str, Any]:
    """Fireworks spend since the account began, per model.

    Fireworks' billing API returns token counts (uncached/cached/output) but
    reports ``costNanoUsd`` as 0, so we compute dollars from tokens using the
    price table above. Those rates are calibrated to the real billing
    dashboard, so the total matches the invoice (~$5). Cached to avoid
    hammering the billing endpoint on every dashboard poll.
    """
    cached = _cached("spend")
    if cached is not None:
        return cached

    model = _current_model()
    price, known = _price_for(model["short"])
    pricing = {
        "input_per_m": price[0],
        "cached_per_m": price[1],
        "output_per_m": price[2],
        "currency": "USD",
        "unit": "1M tokens",
        "known": known,
    }

    usage: Dict[str, Any] = {
        "since": "2026-09-01",
        "total_usd": 0.0,
        "billed_usd": 0.0,
        "credits_note": None,
        "by_model": [],
        "available": False,
        "error": None,
    }

    key = _env_value("FIREWORKS_API_KEY")
    if not key:
        usage["error"] = "no Fireworks key"
    else:
        account_info = _fireworks_account(key)
        if not account_info:
            usage["error"] = "no Fireworks account"
        else:
            try:
                from datetime import timedelta

                account = account_info["name"]
                # billingUsage caps each query at 31 days and rejects
                # fractional seconds — walk 30-day windows from the account's
                # creation to now and dedupe the daily buckets by (model, day).
                now_dt = datetime.now(timezone.utc)
                start_dt = _parse_iso(account_info.get("create_time")) or datetime(
                    2026, 9, 1, tzinfo=timezone.utc
                )
                fmt = "%Y-%m-%dT%H:%M:%SZ"
                seen: Dict[Tuple[str, str], Dict[str, Any]] = {}
                cursor = start_dt
                guard = 0
                while cursor < now_dt and guard < 60:
                    guard += 1
                    win_end = min(cursor + timedelta(days=30), now_dt)
                    data = _fw_get(
                        f"{account}/billingUsage", key,
                        {"startTime": cursor.strftime(fmt), "endTime": win_end.strftime(fmt)},
                    )
                    for r in list(data.get("serverlessCosts") or []) + list(
                        data.get("dedicatedCosts") or []
                    ):
                        seen[(str(r.get("modelName", "")), str(r.get("startTime", "")))] = r
                    cursor = win_end
                rows = list(seen.values())
                by: Dict[str, Dict[str, float]] = {}
                earliest = None
                for r in rows:
                    short = str(r.get("modelName", "")).split("/")[-1] or "other"
                    unc = int(r.get("uncachedPromptTokens", 0) or 0)
                    cac = int(r.get("cachedPromptTokens", 0) or 0)
                    # Older buckets may omit the split; fall back to promptTokens.
                    if unc == 0 and cac == 0:
                        unc = int(r.get("promptTokens", 0) or 0)
                    ct = int(r.get("completionTokens", 0) or 0)
                    st = r.get("startTime")
                    if st and (earliest is None or st < earliest):
                        earliest = st
                    (p_in, p_cache, p_out), _k = _price_for(short)
                    usd = (
                        (unc / 1_000_000) * p_in
                        + (cac / 1_000_000) * p_cache
                        + (ct / 1_000_000) * p_out
                    )
                    slot = by.setdefault(short, {"usd": 0.0, "pt": 0, "ct": 0})
                    slot["usd"] += usd
                    slot["pt"] += unc + cac
                    slot["ct"] += ct
                by_model = [
                    {
                        "model": m,
                        "usd": round(v["usd"], 2),
                        "prompt_tokens": int(v["pt"]),
                        "completion_tokens": int(v["ct"]),
                    }
                    for m, v in sorted(by.items(), key=lambda kv: -kv[1]["usd"])
                ]
                total = round(sum(v["usd"] for v in by.values()), 2)
                usage.update({
                    "available": True,
                    "total_usd": total,
                    "billed_usd": total,
                    "credits_note": None,
                    "by_model": by_model,
                    "since": (earliest or "2026-09-01T00:00:00Z")[:10],
                })
            except Exception as exc:  # noqa: BLE001 - surface, don't crash the page
                usage["error"] = str(exc)

    result = {
        "generated_at": _now_iso(),
        "model": model,
        "pricing": pricing,
        "usage": usage,
        "expenses": _expenses_block(),
    }
    return _set_cached("spend", result, _SPEND_CACHE_TTL_S)


# Terminal states per source (finished work lingers only briefly in the panel).
_DELEG_TERMINAL = {"done", "error", "completed", "failed", "cancelled", "delivered"}
_DELEG_DONE = {"done", "completed", "delivered"}
_DELEG_RECENT_WINDOW_S = 900.0   # keep a finished task visible for ~15 min
# Words that mark open-ended work (coding/research/planning) where an honest
# time estimate isn't possible → we report "no ETA" rather than fake a bar.
_HEAVY_HINTS = (
    "build", "code", "implement", "develop", "refactor", "research", "investigat",
    "plan", "design", "analyz", "write", "draft", "compare", "audit", "debug",
    "deploy", "review", "migrat", "scrape", "summari",
)
_QUICK_EXPECTED_S = 120.0   # typical wall-clock for a simple live-data lookup


def _estimate_progress(kind: str, goal: str, state: str, ago) -> Tuple[Optional[float], Optional[int]]:
    """Best-effort (progress 0..1, eta_seconds) for a spawned agent.

    Honest by design: a finished task is 100%/0; a simple live-data lookup gets
    a time-based estimate against a typical duration; open-ended work (coding,
    research, planning — or any nested agent/team) returns (None, None) so the
    UI shows 'No ETA' instead of a fabricated bar."""
    if state in _DELEG_DONE:
        return 1.0, 0
    if state in _DELEG_TERMINAL:   # error/failed/cancelled — no meaningful bar
        return None, None
    if ago is None:
        return None, None
    g = (goal or "").lower()
    heavy = kind == "agent" or any(h in g for h in _HEAVY_HINTS)
    if heavy:
        # Open-ended work (research/coding/team): no reliable ETA, but show a
        # gentle asymptotic creep so the bar never looks frozen. eta=None makes
        # the UI label it "no ETA" rather than a misleading percentage.
        return round(min(0.9, ago / (ago + 150.0)), 2), None
    prog = max(0.03, min(0.95, ago / _QUICK_EXPECTED_S))
    return round(prog, 2), max(0, int(_QUICK_EXPECTED_S - ago))


_PROGRESS_DB_PATH = _HERMES_HOME / "jarvis_progress.db"


def _deleg_slug(text: str) -> str:
    return _re.sub(r"[^a-z0-9]", "", (text or "").lower())[:24]


def _self_reports(now: float) -> Tuple[List[Dict[str, Any]], set]:
    """Progress rows agents posted via the `jarvis-progress` helper: their own
    percent, ETA, and a note. These are real agent estimates (so they override
    the time heuristic) and — because any agent can post regardless of how it
    was spawned — they also surface inline teams that never touch
    async_delegations. A running agent that stops updating for >2 min is treated
    as stale and hidden."""
    out: List[Dict[str, Any]] = []
    slugs: set = set()
    try:
        conn = sqlite3.connect(f"file:{_PROGRESS_DB_PATH}?mode=ro", uri=True, timeout=1.5)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT key,label,pct,eta_seconds,note,state,started_at,updated_at "
                "FROM progress ORDER BY updated_at DESC LIMIT 12"
            ).fetchall()
        except sqlite3.Error:
            rows = []
        for r in rows:
            d = dict(r)
            upd = d.get("updated_at") or 0.0
            state = (d.get("state") or "running").lower()
            if (now - upd) > _DELEG_RECENT_WINDOW_S:
                continue
            if state == "running" and (now - upd) > 120:
                continue  # went quiet — hide rather than show a frozen bar
            goal = (d.get("label") or d.get("note") or "Agent task").strip()
            slugs.add(_deleg_slug(goal))
            started = d.get("started_at") or upd or now
            pct = d.get("pct")
            prog = None if pct is None else max(0.0, min(1.0, float(pct) / 100.0))
            out.append({
                "id": str(d.get("key") or "")[:12],
                "kind": "agent",
                "goal": " ".join(goal.split())[:120],
                "state": "done" if state == "done" else state,
                "ago_seconds": int(now - started),
                "progress": 1.0 if state == "done" else prog,
                "eta_seconds": 0 if state == "done" else d.get("eta_seconds"),
                "note": (d.get("note") or "").strip()[:120],
                "self": True,
            })
        conn.close()
    except Exception:  # noqa: BLE001 - snapshot must never break the panel
        pass
    return out, slugs


def _delegations_snapshot() -> List[Dict[str, Any]]:
    """Agents JARVIS has spawned, for the Current Work panel: agent self-reports
    (via jarvis-progress — real %/ETA, catches inline teams too), voice-spawned
    background jobs in this process, plus native background delegate_task
    subagents (WhatsApp-origin teams) from state.db. Running work always shows;
    finished work lingers briefly so a just-completed task is still visible."""
    now = time.time()
    out: List[Dict[str, Any]] = []
    # 0) Agent self-reports (real progress/ETA). Their slugs suppress a
    #    duplicate heuristic card for the same async_delegations row.
    self_cards, self_slugs = _self_reports(now)
    out.extend(self_cards)
    # 1) Voice-spawned background jobs (this process).
    try:
        with _voice_pending_lock:
            items = list(_voice_pending.items())
    except Exception:  # noqa: BLE001 - snapshot must never break the panel
        items = []
    for pid, rec in items:
        started = rec.get("started_at") or rec.get("ts") or now
        state = rec.get("status") or "running"
        if state in _DELEG_TERMINAL and (now - (rec.get("ts") or started)) > _DELEG_RECENT_WINDOW_S:
            continue
        display = "delivered" if (state == "done" and rec.get("delivered")) else state
        out.append({
            "id": str(pid)[:12],
            "kind": "voice",
            "goal": " ".join((rec.get("question") or "Voice task").split())[:120],
            "state": display,
            "ago_seconds": int(now - started),
        })
    # 2) Native background delegate_task subagents / teams (state.db).
    try:
        uri = f"file:{_STATE_DB_PATH}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                "SELECT delegation_id, state, dispatched_at, updated_at, "
                "task_json, delivery_state FROM async_delegations "
                "ORDER BY COALESCE(updated_at, dispatched_at) DESC LIMIT 10"
            ).fetchall()
        except sqlite3.Error:
            rows = []
        for r in rows:
            d = dict(r)
            ref = d.get("updated_at") or d.get("dispatched_at")
            state = (d.get("state") or "running").lower()
            if state in _DELEG_TERMINAL and ref and (now - ref) > _DELEG_RECENT_WINDOW_S:
                continue
            try:
                goal = json.loads(d.get("task_json") or "{}").get("goal") or ""
            except Exception:  # noqa: BLE001
                goal = ""
            if _deleg_slug(goal) in self_slugs:
                continue  # the agent is already self-reporting this one
            display = "delivered" if d.get("delivery_state") == "delivered" else state
            out.append({
                "id": str(d.get("delegation_id") or "")[:16],
                "kind": "agent",
                "goal": " ".join((goal or "Delegated task").split())[:120],
                "state": display,
                "ago_seconds": int(now - ref) if ref else None,
            })
        conn.close()
    except Exception:  # noqa: BLE001
        pass
    # Attach an honest progress/ETA estimate (or None → "No ETA") — but never
    # override an agent's own self-report.
    for e in out:
        if e.get("self"):
            continue
        prog, eta = _estimate_progress(e["kind"], e["goal"], e["state"], e.get("ago_seconds"))
        e["progress"] = prog
        e["eta_seconds"] = eta
    # Running first, then most recent; cap at 8.
    out.sort(key=lambda x: (
        x.get("state") in _DELEG_TERMINAL,
        x.get("ago_seconds") if x.get("ago_seconds") is not None else 1e9,
    ))
    return out[:8]


def _live_topic(conn: sqlite3.Connection, session_id: Any, prefer_first: bool = False) -> Optional[Dict[str, Any]]:
    """Latest (or first) user text + freshest message time in a session.
    Long-lived messaging sessions (WhatsApp/Telegram DMs) keep ONE session row
    forever, and the stored title is auto-generated from the OPENING message —
    so weeks later the Current Work panel still shows "Greet and check
    availability" for whatever Enrique is doing right now. Deriving the label
    from the most recent user message fixes that without writing to gateway
    state (this stays read-only). Subagent rows (untitled) use their FIRST
    user message — the delegate_task goal — instead of the latest, which is
    often runtime control chatter (contract-validator rejections, etc.).

    Returns {"topic": str, "last_message_at": float} or None.
    """
    import re  # module-level import happens later in this file

    try:
        rows = conn.execute(
            "SELECT content, timestamp FROM messages "
            "WHERE session_id = ? AND role = 'user' "
            "AND content IS NOT NULL AND TRIM(content) != '' "
            "ORDER BY timestamp " + ("ASC" if prefer_first else "DESC") + " LIMIT 8",
            (session_id,),
        ).fetchall()
    except sqlite3.Error:
        return None
    last_msg_ts: Optional[float] = None
    try:
        for r in conn.execute(
            "SELECT MAX(timestamp) AS m FROM messages WHERE session_id = ?",
            (session_id,),
        ):
            last_msg_ts = r["m"]
    except sqlite3.Error:
        pass
    for r in rows:
        text = " ".join(str(r["content"] or "").split()).strip("\"'“”‘’ ").strip()
        if len(text) < 4:
            continue
        # Skip runtime control chatter and non-prose blobs (JSON payloads).
        low = text.lower()
        if low.startswith((
            "your previous final response was rejected",
            "starting api call",
            "receiving stream response",
        )):
            continue
        # Strip delegation role prefixes ("SENIOR SOFTWARE ENGINEER: ...").
        text = re.sub(r"^[A-Z][A-Z /&()'-]{2,40}:\s*", "", text)
        if text.startswith("{") or text.startswith("["):
            continue
        if len(text) > 72:
            text = text[:69].rstrip(" ,.;:-") + "…"
        return {"topic": text, "last_message_at": last_msg_ts}
    return None


# Sessions that live in one perpetual row per chat; their stored title reflects
# the first message ever, so Current Work shows a fresh topic instead.
_MESSAGING_SOURCES = {"whatsapp", "telegram", "discord", "slack", "signal", "imessage", "matrix", "teams"}


def _recent_activity() -> Dict[str, Any]:
    """Recent + live sessions from state.db, so Current Work reflects real work."""
    cached = _cached("activity")
    if cached is not None:
        return cached

    sessions: List[Dict[str, Any]] = []
    active_count = 0
    delegations_inflight = 0
    available = False
    error: Optional[str] = None
    now = time.time()

    try:
        uri = f"file:{_STATE_DB_PATH}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT id, source, model, title, last_activity_at, started_at,
                       last_activity_description, message_count, tool_call_count,
                       input_tokens, output_tokens, ended_at, end_reason
                FROM sessions
                WHERE COALESCE(archived, 0) = 0 AND COALESCE(hidden, 0) = 0
                ORDER BY COALESCE(
                    (SELECT MAX(timestamp) FROM messages m WHERE m.session_id = sessions.id),
                    last_activity_at, started_at) DESC
                LIMIT 40
                """
            ).fetchall()
            for r in rows:
                d = dict(r)
                ts = d.get("last_activity_at") or d.get("started_at")
                ago = int(now - ts) if ts else None
                title = (d.get("title") or "").strip()
                if not title:
                    title = (d.get("last_activity_description") or "").strip() or "Untitled session"
                # Messaging chats are one perpetual session; the stored title is
                # from the FIRST message ever (e.g. "Greet and check
                # availability" from days ago). Show what the conversation is
                # about NOW instead, so WhatsApp-started work is recognizable.
                # (The card's meta line already shows the source, so no prefix.)
                # Also use the freshest message timestamp for the "ago"/live
                # computation — last_activity_at on the row lags mid-turn.
                topic_info = None
                if d.get("source") in _MESSAGING_SOURCES:
                    topic_info = _live_topic(conn, d.get("id"))
                elif d.get("source") == "subagent" or title == "Untitled session":
                    # Subagent rows: the stored title/description is runtime
                    # chatter ("starting API call #1", "receiving stream
                    # response") — the FIRST user message is the actual task.
                    topic_info = _live_topic(conn, d.get("id"), prefer_first=True)
                if topic_info and topic_info.get("topic"):
                    title = topic_info["topic"]
                if topic_info and topic_info.get("last_message_at"):
                    ts = max(ts or 0, topic_info["last_message_at"])
                    ago = int(now - ts)
                # Live = never formally closed AND touched in the last 5 minutes.
                is_active = d.get("end_reason") in (None, "") and ago is not None and ago < 300
                if is_active:
                    active_count += 1
                sessions.append({
                    "id": d.get("id"),
                    "title": title,
                    "source": d.get("source") or "session",
                    "model": (d.get("model") or "").split("/")[-1],
                    "messages": int(d.get("message_count") or 0),
                    "tools": int(d.get("tool_call_count") or 0),
                    "ago_seconds": ago,
                    "active": is_active,
                    "input_tokens": int(d.get("input_tokens") or 0),
                    "output_tokens": int(d.get("output_tokens") or 0),
                })
            try:
                delegations_inflight = conn.execute(
                    "SELECT COUNT(*) FROM async_delegations "
                    "WHERE state NOT IN ('completed', 'failed', 'cancelled')"
                ).fetchone()[0]
            except sqlite3.Error:
                delegations_inflight = 0
            available = True
        finally:
            conn.close()
    except Exception as exc:  # noqa: BLE001
        error = str(exc)

    result = {
        "generated_at": _now_iso(),
        "sessions": sessions,
        "active_count": active_count,
        "delegations_inflight": delegations_inflight,
        "delegations": _delegations_snapshot(),
        "available": available,
        "error": error,
    }
    return _set_cached("activity", result, _ACTIVITY_CACHE_TTL_S)


@router.get("/api/control/spend")
async def control_spend():
    return _fireworks_spend()


@router.get("/api/control/zai_usage")
async def control_zai_usage():
    return _zai_usage()


@router.get("/api/control/activity")
async def control_activity():
    return _recent_activity()


# ===========================================================================
# Core vitals / automations / attention / knowledge graph --------------------
# Added for the redesigned Control Center. All stdlib + local files; no secret
# ever reaches the browser — only computed numbers.
# ===========================================================================
import shutil as _shutil
from datetime import timedelta as _timedelta

_VITALS_CACHE_TTL_S = 2.0
_AUTOMATIONS_CACHE_TTL_S = 30.0
_GRAPH_CACHE_TTL_S = 300.0
_JARVIS_DIR = _HERMES_HOME / "jarvis"
_AUTOMATIONS_PATH = _JARVIS_DIR / "automations.json"
_GRAPH_AGG_PATH = _JARVIS_DIR / "graph" / "aggregate.json"
_cpu_prev = {"total": 0, "idle": 0}


def _read_proc_stat_cpu() -> Optional[Tuple[int, int]]:
    try:
        with open("/proc/stat", "r", encoding="utf-8") as fh:
            first = fh.readline()
    except OSError:
        return None
    parts = first.split()
    if not parts or parts[0] != "cpu":
        return None
    try:
        nums = [int(x) for x in parts[1:]]
    except ValueError:
        return None
    idle = nums[3] + (nums[4] if len(nums) > 4 else 0)
    return sum(nums), idle


def _vitals() -> Dict[str, Any]:
    cached = _cached("vitals")
    if cached is not None:
        return cached
    v: Dict[str, Any] = {"cpu_pct": None}
    cur = _read_proc_stat_cpu()
    if cur:
        total, idle = cur
        dt = total - _cpu_prev["total"]
        di = idle - _cpu_prev["idle"]
        if _cpu_prev["total"] and dt > 0:
            v["cpu_pct"] = round(max(0.0, min(100.0, (1 - di / dt) * 100)), 1)
        _cpu_prev["total"], _cpu_prev["idle"] = total, idle
    try:
        mem: Dict[str, int] = {}
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                k, _, rest = line.partition(":")
                mem[k.strip()] = int(rest.strip().split()[0])
        total_kb = mem.get("MemTotal", 0)
        avail_kb = mem.get("MemAvailable", mem.get("MemFree", 0))
        v["mem_used_mb"] = round((total_kb - avail_kb) / 1024)
        v["mem_total_mb"] = round(total_kb / 1024)
    except (OSError, ValueError, KeyError):
        pass
    try:
        du = _shutil.disk_usage("/")
        v["disk_used_gb"] = round(du.used / 1e9)
        v["disk_total_gb"] = round(du.total / 1e9)
    except OSError:
        pass
    try:
        with open("/proc/uptime", encoding="utf-8") as fh:
            v["uptime_seconds"] = int(float(fh.readline().split()[0]))
    except (OSError, ValueError):
        pass
    try:
        with open("/proc/loadavg", encoding="utf-8") as fh:
            v["load"] = [float(x) for x in fh.readline().split()[:3]]
    except (OSError, ValueError):
        pass
    v["nproc"] = os.cpu_count()
    if v["cpu_pct"] is None and v.get("load") and v.get("nproc"):
        v["cpu_pct"] = round(min(100.0, v["load"][0] / v["nproc"] * 100), 1)
    return _set_cached("vitals", v, _VITALS_CACHE_TTL_S)


@router.get("/api/control/vitals")
async def control_vitals():
    return _vitals()


def _job_domain(name: str) -> str:
    """Map a real cron-job name to a Control-Center domain."""
    l = (name or "").lower()
    if l.startswith("aidp") or "krendora" in l or "instagram" in l or "dsers" in l or "autods" in l:
        return "krendora"
    if any(k in l for k in (
        "tft", "flare", "tm-", "tm ", "axs", "stubhub", "scrape", "ticket",
        "presale", "broker", "copilot", "vivid", "seatgeek", "tickpick", "gametime",
    )):
        return "ticketflipping"
    if any(k in l for k in (
        "ledger", "budget", "finance", "grandma", "i131", "erequest", "immigr",
        "home", "call-", "reminder", "timer", "followup", "personal",
    )):
        return "personal"
    return "system"


def _pretty_cron(expr: str) -> str:
    """Best-effort human cadence for a 5-field cron; falls back to the raw expr."""
    parts = (expr or "").split()
    if len(parts) != 5:
        return expr or ""
    mi, ho, dom, mon, dow = parts
    try:
        if mi.startswith("*/") and ho == "*" and dom == "*" and mon == "*" and dow == "*":
            return f"every {int(mi[2:])}m"
        if ho.startswith("*/") and mi.lstrip("-").isdigit() and dom == "*" and mon == "*" and dow == "*":
            return f"every {int(ho[2:])}h"
        if mi.isdigit() and ho.isdigit() and dom == "*" and mon == "*":
            hh = f"{int(ho):02d}:{int(mi):02d}"
            if dow == "*":
                return f"daily {hh}"
            return f"{hh} · days {dow}"
        if mi.isdigit() and "," in ho and dom == "*" and mon == "*" and dow == "*":
            return f"{ho.replace(',', ' & ')}h daily"
    except ValueError:
        pass
    return expr


def _schedule_cadence(job: Dict[str, Any]) -> str:
    sched = job.get("schedule") or {}
    kind = sched.get("kind")
    if kind == "interval":
        m = sched.get("minutes")
        if isinstance(m, int) and m > 0:
            if m % 60 == 0:
                return f"every {m // 60}h"
            return f"every {m}m"
    if kind == "cron":
        return _pretty_cron(sched.get("expr") or job.get("schedule_display") or "")
    if kind == "once":
        return job.get("schedule_display") or "one-time"
    return job.get("schedule_display") or (sched.get("display") if isinstance(sched, dict) else "") or ""


def _automations() -> Dict[str, Any]:
    """Real scheduled tasks from Hermes' own cron store (cron.jobs.list_jobs) —
    the same jobs `hermes cron list` shows. Recurring jobs + still-upcoming
    one-shots; finished one-shots are dropped. status: active|paused|failing."""
    cached = _cached("automations")
    if cached is not None:
        return cached
    out: Dict[str, Any] = {"available": False, "items": [], "active": 0, "failing": 0}
    try:
        from cron.jobs import list_jobs
    except Exception:  # noqa: BLE001 - cron module unavailable → empty panel
        return _set_cached("automations", out, _AUTOMATIONS_CACHE_TTL_S)
    try:
        jobs = list_jobs(include_disabled=True)
    except Exception:  # noqa: BLE001
        return _set_cached("automations", out, _AUTOMATIONS_CACHE_TTL_S)
    now_dt = datetime.now(timezone.utc)
    result: List[Dict[str, Any]] = []
    for job in jobs or []:
        sched = job.get("schedule") or {}
        kind = sched.get("kind")
        state = (job.get("state") or "").lower()
        next_run = job.get("next_run_at")
        next_secs: Optional[int] = None
        if next_run:
            try:
                nd = datetime.fromisoformat(str(next_run).replace("Z", "+00:00"))
                if nd.tzinfo is None:
                    nd = nd.replace(tzinfo=timezone.utc)
                next_secs = int((nd - now_dt).total_seconds())
            except ValueError:
                next_secs = None
        # Drop finished / expired one-shots; keep recurring + upcoming one-shots.
        if kind == "once":
            if state in ("completed", "cancelled", "failed") or next_secs is None or next_secs < -60:
                continue
        elif state in ("completed", "cancelled"):
            continue
        enabled = job.get("enabled", True)
        paused = bool(job.get("paused_at")) or not enabled
        failing = (job.get("last_status") == "error") or (int(job.get("failure_streak") or 0) > 0)
        status = "paused" if paused else ("failing" if failing else "active")
        name = job.get("name") or "automation"
        entry: Dict[str, Any] = {
            "name": name,
            "domain": _job_domain(name),
            "cadence": _schedule_cadence(job),
            "status": status,
        }
        if status != "paused" and next_secs is not None and next_secs >= -60:
            entry["next_seconds"] = max(0, next_secs)
        if job.get("last_status"):
            entry["last_status"] = job.get("last_status")
        if job.get("last_run_at"):
            entry["last_run_at"] = job.get("last_run_at")
        result.append(entry)
    rank = {"active": 0, "failing": 1, "paused": 2}
    result.sort(key=lambda e: (rank.get(e["status"], 9), e.get("next_seconds", 10 ** 12)))
    out["available"] = True
    out["items"] = result
    out["active"] = sum(1 for r in result if r["status"] == "active")
    out["failing"] = sum(1 for r in result if r["status"] == "failing")
    return _set_cached("automations", out, _AUTOMATIONS_CACHE_TTL_S)


@router.get("/api/control/automations")
async def control_automations():
    return _automations()


def _voice_transcripts(limit_turns: int = 16) -> Dict[str, Any]:
    """Recent turns from the newest real voice conversation. ``work-*`` task
    chats are excluded (those live in the Current Work chat). Read-only."""
    cached = _cached("voice_transcripts")
    if cached is not None:
        return cached
    out: Dict[str, Any] = {"available": False, "conversation_id": None, "updated_ts": None, "turns": []}
    try:
        files = sorted(
            (f for f in _VOICE_DISK_DIR.glob("*.jsonl") if not f.stem.startswith("work-")),
            key=lambda pth: pth.stat().st_mtime,
            reverse=True,
        )
    except Exception:  # noqa: BLE001
        return _set_cached("voice_transcripts", out, 5.0)
    if not files:
        return _set_cached("voice_transcripts", out, 5.0)
    chosen = files[0]
    turns: List[Dict[str, Any]] = []
    try:
        with chosen.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue
                if rec.get("role") in ("user", "assistant") and rec.get("text"):
                    txt = " ".join(str(rec["text"]).split())
                    if len(txt) > 500:
                        txt = txt[:499].rstrip() + "…"
                    turns.append({"role": rec["role"], "text": txt, "ts": rec.get("ts")})
    except OSError:
        return _set_cached("voice_transcripts", out, 5.0)
    try:
        mtime: Optional[float] = chosen.stat().st_mtime
    except OSError:
        mtime = None
    out["available"] = bool(turns)
    out["conversation_id"] = chosen.stem
    out["updated_ts"] = mtime
    out["turns"] = turns[-limit_turns:]
    return _set_cached("voice_transcripts", out, 5.0)


@router.get("/api/control/voice/transcripts")
async def control_voice_transcripts():
    return _voice_transcripts()


def _attention_alerts() -> Dict[str, Any]:
    """Alerts JARVIS surfaces: failed delegations + waiting sessions + failing automations."""
    alerts: List[Dict[str, Any]] = []
    try:
        act = _recent_activity()
        for d in act.get("delegations", []) or []:
            if d.get("state") in ("error", "failed", "cancelled"):
                alerts.append({"severity": "crit", "title": d.get("goal", "task"),
                               "msg": d.get("note") or "task failed", "kind": "task", "ref": d.get("id")})
        for s in act.get("sessions", []) or []:
            if s.get("state") == "idle" or s.get("waiting"):
                alerts.append({"severity": "info", "title": s.get("title", "session"),
                               "msg": "waiting", "kind": "session", "ref": s.get("id")})
    except Exception:
        pass
    try:
        for a in _automations().get("items", []):
            if a.get("status") == "failing":
                alerts.append({"severity": "crit", "title": a["name"],
                               "msg": "automation failing · " + a.get("cadence", ""),
                               "kind": "automation", "ref": a["name"]})
    except Exception:
        pass
    return {"alerts": alerts, "count": len(alerts),
            "critical": sum(1 for a in alerts if a["severity"] == "crit")}


@router.get("/api/control/attention")
async def control_attention():
    return _attention_alerts()


def _knowledge_graph() -> Dict[str, Any]:
    """The knowledge-map payload, from the graphify aggregate at
    ~/.hermes/jarvis/graph/aggregate.json (built by scripts/build_graph.py)."""
    cached = _cached("knowledge_graph")
    if cached is not None:
        return cached
    try:
        data = json.loads(_GRAPH_AGG_PATH.read_text(encoding="utf-8"))
        data["available"] = True
    except (OSError, ValueError):
        data = {"available": False, "repos": []}
    return _set_cached("knowledge_graph", data, _GRAPH_CACHE_TTL_S)


@router.get("/api/control/knowledge_graph")
async def control_knowledge_graph():
    return _knowledge_graph()


# ===========================================================================
# Voice agent (Control Center mic) -------------------------------------------
# The browser captures speech (Web Speech API) and sends the transcript here.
# We run one real JARVIS turn headlessly (``hermes -z`` — full tools + memory)
# and speak the reply back in the cloned "JARVIS" ElevenLabs voice. The
# ElevenLabs key and the model both stay server-side: the browser only ever
# sees text and an ``audio/mpeg`` stream. Conversation continuity is kept
# here (a short rolling history), because one-shot ``hermes -z`` sessions do
# not reliably resume by name.
# ===========================================================================

import re as _re
import subprocess
import tempfile
import threading
import uuid

from fastapi import Body, HTTPException, Response
from fastapi.concurrency import run_in_threadpool

_HERMES_BIN = "/usr/local/bin/hermes"
_VOICE_TURN_TIMEOUT_S = 120.0
_VOICE_BG_TIMEOUT_S = 600.0   # background delegate may spin up a team — give it room
_VOICE_REASONING = "none"   # full/delegated path only executes tools (fast path handles chat); none is fastest (36s vs 107s@low on a calendar turn)
_VOICE_TIMEOUT_REPLY = ("Sir, that one took longer than my time limit and I had to stop before finishing — I don't have a complete answer for you yet. Ask me to run it again and I'll take another pass.")
_VOICE_MAX_INPUT_CHARS = 800
_VOICE_TTS_MAX_CHARS = 1200
_VOICE_HISTORY_TURNS = 24         # keep the last N (user + assistant) exchanges (survives restarts via disk)
_VOICE_HISTORY_TTL_S = 30 * 86400.0  # forget an idle voice conversation after 30 days
_ELEVEN_BASE = "https://api.elevenlabs.io/v1"
_ELEVEN_DEFAULT_VOICE = "3xOZA9B4KTVQOOZaSbXn"   # cloned "JARVIS"
_ELEVEN_DEFAULT_MODEL = "eleven_turbo_v2_5"   # low-latency; IVC-capable

_VOICE_PREAMBLE = (
    "[Voice mode] You are speaking OUT LOUD to Enrique over a live voice call. "
    "Answer in at most two short, natural spoken sentences. Plain speech only: "
    "no markdown, no bullet lists, no code blocks, no emoji, no stage directions. "
    "Answer simple things directly and briefly; for anything that benefits from it, take the time to think or look things up before you answer — accuracy over speed. But you are on a live voice call, so never grind in silence: if a request needs deep research, long writing, or several steps, give a one-line spoken plan and hand the heavy work to a background delegate (delegate_task with background true), or offer to finish it in chat / WhatsApp — don't try to complete it all in this turn. Prefer one small concrete action now over a long monologue. You can accomplish almost anything by delegating, so know your limits but never refuse for lack of a tool or access — kick it off with a background delegate and say what you've set in motion."
)

# conversation_id -> {"turns": [(role, text), ...], "ts": float}
# HYBRID memory + disk: the dict is a write-through cache; every append also
# appends to ~/.hermes/voice_conversations/<id>.jsonl, and reads fall back to
# disk, so voice conversations SURVIVE dashboard restarts (previously the whole
# history lived only in this dict and every restart wiped Enrique's voice
# memory). Files are pruned by _voice_prune after _VOICE_HISTORY_TTL_S idle.
_voice_sessions: Dict[str, Dict[str, Any]] = {}
_voice_lock = threading.Lock()   # serialize the hermes subprocess + history
_VOICE_DISK_DIR = Path.home() / ".hermes" / "voice_conversations"


def _voice_disk_path(conversation_id: str) -> Path:
    safe = _re.sub(r"[^A-Za-z0-9_-]", "", str(conversation_id))[:64]
    return _VOICE_DISK_DIR / f"{safe or 'anon'}.jsonl"


def _voice_disk_append(conversation_id: str, role: str, text: str, ts: float) -> None:
    """Append one turn to the on-disk conversation log (crash-safe)."""
    try:
        _VOICE_DISK_DIR.mkdir(parents=True, exist_ok=True)
        with _voice_disk_path(conversation_id).open("a", encoding="utf-8") as fh:
            fh.write(json.dumps({"role": role, "text": text, "ts": ts}, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001 - memory is best-effort; never break a voice turn
        pass


def _voice_disk_load(conversation_id: str) -> List[Tuple[str, str]]:
    """Load (role, text) turns from disk, newest-last, capped to history size."""
    try:
        turns: List[Tuple[str, str]] = []
        with _voice_disk_path(conversation_id).open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except Exception:  # noqa: BLE001 - skip malformed lines
                    continue
                if rec.get("role") in ("user", "assistant") and rec.get("text"):
                    turns.append((rec["role"], str(rec["text"])))
        return turns[-(_VOICE_HISTORY_TURNS * 2):]
    except Exception:  # noqa: BLE001
        return []


def _voice_disk_touch_ts(conversation_id: str, ts: float) -> None:
    """Update the file mtime so idle-expiry tracks the last real activity."""
    try:
        p = _voice_disk_path(conversation_id)
        if p.exists():
            os.utime(p, (ts, ts))
    except Exception:  # noqa: BLE001
        pass


def _voice_prune(now: float) -> None:
    stale = [k for k, v in _voice_sessions.items() if now - v.get("ts", 0.0) > _VOICE_HISTORY_TTL_S]
    for k in stale:
        _voice_sessions.pop(k, None)
    try:
        if _VOICE_DISK_DIR.is_dir():
            cutoff = now - _VOICE_HISTORY_TTL_S
            for f in _VOICE_DISK_DIR.glob("*.jsonl"):
                try:
                    if f.stat().st_mtime < cutoff:
                        f.unlink(missing_ok=True)
                except OSError:
                    pass
    except Exception:  # noqa: BLE001
        pass


def _voice_clean_reply(text: str) -> str:
    text = (text or "").strip()
    text = _re.sub(r"^(JARVIS|Assistant)\s*:\s*", "", text, flags=_re.IGNORECASE)
    text = text.replace("`", "")
    text = _re.sub(r"\*\*(.*?)\*\*", r"\1", text)
    text = _re.sub(r"\*(.*?)\*", r"\1", text)
    # Strip markdown list/heading markers at line starts — TTS shouldn't read
    # "dash", "1.", or "#".
    text = _re.sub(r"(?m)^\s*#{1,6}\s*", "", text)
    text = _re.sub(r"(?m)^\s*(?:[-*•]|\d+[.)])\s+", "", text)
    # Collapse newlines to spaces for smoother speech.
    text = _re.sub(r"\s*\n\s*", " ", text)
    # Drop emoji / pictographs / dingbats / flags / variation selectors, while
    # keeping normal punctuation (em dash, curly quotes, ellipsis).
    text = _re.sub(
        r"[\U0001F300-\U0001FAFF\U00002600-\U000026FF\U00002700-\U000027BF\U0001F1E6-\U0001F1FF\U0000FE0F]",
        "",
        text,
    )
    text = _re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


# Prompt for the BACKGROUND delegate. Unlike the live-call preamble it is NOT
# time-boxed to two spoken sentences: it should fully complete the task —
# spawning a typed team for substantial coding/research/planning jobs and
# synthesising their work — and produce a complete, WhatsApp-ready answer.
_VOICE_BG_PREAMBLE = (
    "[Background task] You are JARVIS, working in the background to FULLY complete a request "
    "Enrique made by voice. He is NOT on a live call now — take the time you need and use any "
    "tools required to get a correct, complete result. Do the work to completion; do NOT defer "
    "it, ask him to retry elsewhere, or reply with a plan instead of the actual result.\n"
    "If it is a substantial coding, development, planning, or research job, decompose it and "
    "delegate to a small typed team with delegate_task, then wait for and synthesise their work:\n"
    "- Senior Software Engineer — owns build/dev work; may run a 3-5 worker team (planning, "
    "implementation, testing, deployment).\n"
    "- Researcher — gathers and verifies information; may fan out up to 10 parallel workers when "
    "the question genuinely splits into independent strands (only when it helps).\n"
    "- Ditto (generalist) — anything else; can also stand up and coordinate its own workers.\n"
    "Each teammate you spawn can run its own small team of workers, but those workers are the "
    "final tier and cannot delegate further. Spawn a team only when it genuinely helps — a quick "
    "lookup you can do yourself needs no team.\n"
    "Your reply is delivered to Enrique on WhatsApp, so write a clear, self-contained message: "
    "lead with the answer, normal prose in short paragraphs, simple bullet lists where useful, "
    "no code fences unless he asked for code. "
    "You have no time limit here — keep working until the task is genuinely done, however long it "
    "takes; never stop early, reply with just a plan, or tell him to retry elsewhere. Resolve minor "
    "ambiguity yourself with reasonable assumptions and state them briefly. ONLY if you truly cannot "
    "proceed without information that only Enrique can give, make your WhatsApp reply one short, "
    "specific clarifying question instead of guessing — he will answer on WhatsApp and you continue "
    "from there. Never ask about things you can decide yourself."
)


def _voice_build_prompt(history: List[Tuple[str, str]], user_text: str,
                        background: bool = False) -> str:
    preamble = _VOICE_BG_PREAMBLE if background else _VOICE_PREAMBLE
    lines = [preamble + _now_local_hint(), ""]
    if history:
        lines.append("Recent conversation:")
        for role, text in history:
            who = "Enrique" if role == "user" else "JARVIS"
            lines.append(f"{who}: {text}")
        lines.append("")
    lines.append(f"Enrique: {user_text}")
    lines.append("JARVIS:")
    return "\n".join(lines)


# --- Fast warm front-end (Z.AI direct) + ASYNC delegation -------------------
# The dashboard process is already warm, so a conversational turn skips the ~5s
# `hermes -z` cold start: we call Z.AI glm-5.3-flash directly (~1.5s, thinking
# disabled) for chat/knowledge, and only defer to the FULL Hermes agent (tools +
# memory + delegation) when the fast model replies "DELEGATE:". Delegated turns
# are ASYNC — converse returns the spoken ack + a pending_id immediately, the
# full agent runs in a background thread, and the browser polls
# /voice/result/{id} for the real answer, so the voice always answers promptly.
_ZAI_CHAT_URL = "https://api.z.ai/api/coding/paas/v4/chat/completions"
_ZAI_MODEL = "glm-5.3-flash"
_ZAI_FAST_TIMEOUT_S = 20.0
_DELEGATE_ACK_DEFAULT = "On it, sir — working on it, I'll report back."
_VOICE_PENDING_TTL_S = 600.0

# --- WhatsApp delivery of delegated answers ---------------------------------
# Heavy/slow/coding/research work is handed to a background agent (which may
# itself spawn a typed team — see delegation.max_spawn_depth in config.yaml).
# The voice call stays snappy: JARVIS acks now, and the finished answer is
# delivered to Enrique's WhatsApp through the gateway bot he already talks to,
# so nothing is lost if he has stepped away from the mic.
_WA_BRIDGE_BASE = "http://127.0.0.1:3000"
_WA_SEND_TIMEOUT_S = 15.0
_WA_PROMISE = "I'll send the answer to your WhatsApp."
_FAST_SYSTEM = (
    "You are JARVIS, Enrique's personal and professional agent, speaking OUT LOUD on a live voice call. Be direct and terse: lead with the answer, no filler, no needless preamble, and be honest about uncertainty (a plain 'I don't know' beats a confident guess). "
    "You are the FAST front-end. Answer in at most two short, natural spoken sentences — plain speech, "
    "no markdown, no lists, no emoji.\n"
    "You CAN answer directly from your own knowledge: greetings, chit-chat, general knowledge, opinions, "
    "explanations, quick reasoning, definitions, math.\n"
    "You CANNOT directly access Enrique's private data (calendar, email, files, messages, accounts, his "
    "PC), browse the live web, run code or commands, send messages, or take real-world actions. For ANY "
    "request that needs those, do NOT guess or invent — reply with EXACTLY one line:\n"
    "DELEGATE: <one short spoken sentence saying you're on it>\n"
    "Rules: answer directly when you can; use DELEGATE for anything needing live data, his private data, "
    "tools, or an action; never invent facts about his schedule, accounts, or files. "
    "You are on a PHONE CALL: NEVER ask a clarifying or follow-up question — if the ask is ambiguous, "
    "either answer with your best guess stated plainly, or reply DELEGATE and let the background agent "
    "work it out. Never end your turn with a question."
)

# pending_id -> {"status": running|done|error, "reply": str|None, "ts": float}
_voice_pending: Dict[str, Dict[str, Any]] = {}
_voice_pending_lock = threading.Lock()

# --- Durable voice-job records (disk) ----------------------------------------
# Every delegated voice ask gets a job record under
# ~/.hermes/voice_conversations/jobs/<job_id>.json (task, timestamp, status,
# result summary). Memory-only pending state dies on restart and expires after
# 10 minutes; these records persist, so "what's the status" works hours or days
# later and across dashboard restarts.
_VOICE_JOBS_DIR = _VOICE_DISK_DIR / "jobs"


def _voice_job_path(job_id: str) -> Path:
    safe = _re.sub(r"[^A-Za-z0-9_-]", "", str(job_id))[:64]
    return _VOICE_JOBS_DIR / f"{safe or 'job'}.json"


def _voice_job_write(job_id: str, record: Dict[str, Any]) -> None:
    try:
        _VOICE_JOBS_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _voice_job_path(job_id).with_suffix(".tmp")
        tmp.write_text(json.dumps(record, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, _voice_job_path(job_id))
    except Exception:  # noqa: BLE001 - job bookkeeping is best-effort
        pass


def _voice_job_load(job_id: str) -> Optional[Dict[str, Any]]:
    try:
        return json.loads(_voice_job_path(job_id).read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return None


def _voice_jobs_recent(limit: int = 8) -> List[Dict[str, Any]]:
    """Newest-first list of recent job records (for the status intent)."""
    try:
        files = sorted(
            _VOICE_JOBS_DIR.glob("*.json"),
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )[:limit]
    except Exception:  # noqa: BLE001
        return []
    out: List[Dict[str, Any]] = []
    for f in files:
        try:
            rec = json.loads(f.read_text(encoding="utf-8"))
            if isinstance(rec, dict):
                out.append(rec)
        except Exception:  # noqa: BLE001
            continue
    return out


def _recover_orphan_jobs() -> None:
    """On process start, any job still marked 'running' belongs to a dead
    worker thread — mark it interrupted so status reads stay truthful."""
    try:
        _VOICE_JOBS_DIR.mkdir(parents=True, exist_ok=True)
        for f in _VOICE_JOBS_DIR.glob("*.json"):
            try:
                rec = json.loads(f.read_text(encoding="utf-8"))
            except Exception:  # noqa: BLE001
                continue
            if isinstance(rec, dict) and rec.get("status") == "running":
                rec["status"] = "error"
                rec["error"] = "interrupted by dashboard restart"
                _voice_job_write(str(rec.get("job_id") or f.stem), rec)
    except Exception:  # noqa: BLE001
        pass


_voice_job_status_line_guard = {"done": False}


def _voice_job_status_line() -> str:
    """One or two spoken sentences summarizing recent background voice jobs.
    The first call in this process also marks restart-orphaned jobs (status
    'running' but no live worker thread) as interrupted, so the spoken status
    is never a lie after a dashboard restart."""
    if not _voice_job_status_line_guard["done"]:
        _voice_job_status_line_guard["done"] = True
        _recover_orphan_jobs()
    jobs = _voice_jobs_recent()
    if not jobs:
        return "No background tasks on the books, sir — everything I owed you is done."
    running = [j for j in jobs if j.get("status") == "running"]
    done = [j for j in jobs if j.get("status") == "done"]
    errored = [j for j in jobs if j.get("status") == "error"]
    parts: List[str] = []
    if running:
        names = "; ".join(str(j.get("task", ""))[:60] for j in running[:2])
        parts.append(f"Still working on: {names}")
    if done:
        parts.append(f"{len(done)} task(s) finished" + (
            f" and sent to your WhatsApp" if any(j.get("delivered") for j in done) else ""))
    if errored:
        parts.append(f"{len(errored)} ran into trouble")
    return ("Sir, " + " — ".join(parts) + ".") if parts else \
        "No background tasks on the books, sir."


def _now_local_hint() -> str:
    """One-line current date/time hint (Enrique local tz) for the fast prompt."""
    try:
        from zoneinfo import ZoneInfo
        now = datetime.now(ZoneInfo("America/New_York")).strftime("%A, %B %-d, %Y, %-I:%M %p %Z")
    except Exception:
        now = datetime.now(timezone.utc).strftime("%A, %B %-d, %Y, %-I:%M %p UTC")
    return (" Context: the current date and time in Enrique local timezone "
            "(America/New_York) is " + now + ". Answer date, time, and day-of-week "
            "questions directly from this; do not delegate them.")


_profile_hint_cache: Dict[str, Any] = {"mtime": None, "value": ""}


def _user_profile_hint() -> str:
    """Compact static profile of Enrique for the fast prompt, from Hermes'
    own USER.md (the same profile the full agent uses). Operational/token
    lines are stripped; only personal facts remain, so the fast path can
    answer 'who is / family / work / routine / preferences' instantly while
    still delegating anything live or changing. Cached by mtime so we only
    re-read/re-parse when USER.md actually changes, and we serve the last-good
    value if a read hits Hermes' memory-write lock transiently."""
    path = Path.home() / ".hermes" / "memories" / "USER.md"
    try:
        mtime = path.stat().st_mtime
    except Exception:
        return _profile_hint_cache.get("value") or ""
    if _profile_hint_cache.get("mtime") == mtime and _profile_hint_cache.get("value"):
        return _profile_hint_cache["value"]
    try:
        raw = path.read_text(encoding="utf-8")
    except Exception:
        return _profile_hint_cache.get("value") or ""
    keep: List[str] = []
    for seg in raw.split("§"):  # USER.md uses the section sign as a delimiter
        s = " ".join(seg.split()).strip()
        if not s:
            continue
        low = s.lower()
        if any(k in low for k in ("token", "pc bridge", "pc_bridge", "127.0.0.1", "secret", "password", "credential")):
            continue
        keep.append(s)
    profile = " ".join(keep)[:1200]
    value = (
        ""
        if not profile
        else (
            " Background you already know about Enrique (static facts — use these to answer questions about "
            "who he is, his family, work, routine, faith, or preferences; but still DELEGATE anything live "
            "or changing, e.g. calendar events, new email, messages, or current status): " + profile
        )
    )
    _profile_hint_cache["mtime"] = mtime
    _profile_hint_cache["value"] = value
    return value


def _zai_fast(
history: List[Tuple[str, str]], user_text: str) -> Optional[str]:
    """One fast conversational reply from Z.AI (warm, in-process, ~1.5s).

    Returns the raw model text (which may be a ``DELEGATE: ...`` line), or None
    when the fast path is unavailable/failed so the caller falls back to the
    full Hermes agent.
    """
    key = _env_value("ZAI_API_KEY")
    if not key:
        return None
    messages: List[Dict[str, str]] = [{"role": "system", "content": _FAST_SYSTEM + _now_local_hint() + _user_profile_hint()}]
    for role, text in history:
        messages.append({"role": "assistant" if role == "assistant" else "user", "content": text})
    messages.append({"role": "user", "content": user_text})
    body = json.dumps({
        "model": _ZAI_MODEL,
        "messages": messages,
        "max_tokens": 220,
        "temperature": 0.6,
        "thinking": {"type": "disabled"},
    }).encode("utf-8")
    req = urllib.request.Request(
        _ZAI_CHAT_URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_ZAI_FAST_TIMEOUT_S) as resp:
            data = json.load(resp)
        content = (data["choices"][0]["message"].get("content") or "").strip()
    except Exception:  # noqa: BLE001 - any failure => fall back to full agent
        return None
    return content or None


def _full_hermes_reply(history: List[Tuple[str, str]], user_text: str,
                       background: bool = False) -> str:
    """Full JARVIS turn via ``hermes -z`` (tools + memory + delegation). Slower
    (~30s+); used only when the fast front-end defers with DELEGATE. In
    ``background`` mode it runs the completion-oriented prompt (may spawn a
    typed team), gets a longer timeout, and keeps markdown formatting for the
    WhatsApp-bound answer instead of flattening it for speech."""
    prompt = _voice_build_prompt(history, user_text, background=background)
    argv = [_HERMES_BIN, "-z", prompt]
    if _VOICE_REASONING:
        argv += ["--reasoning", _VOICE_REASONING]
    # Background/delegated voice tasks run like any WhatsApp task: NO time
    # limit — let the full agent run to completion however long it takes.
    timeout_s = None if background else _VOICE_TURN_TIMEOUT_S
    timed_out = False
    proc = None
    try:
        proc = subprocess.run(
            argv, capture_output=True, text=True,
            timeout=timeout_s, cwd=str(Path.home()),
            env={**os.environ, "NO_COLOR": "1", "TERM": "dumb"},
        )
    except subprocess.TimeoutExpired:
        timed_out = True
    if timed_out:
        return _VOICE_TIMEOUT_REPLY
    reply = (_light_clean_reply if background else _voice_clean_reply)(proc.stdout or "")
    if proc.returncode != 0 and not reply:
        tail = (proc.stderr or "").strip().splitlines()
        raise RuntimeError((tail[-1] if tail else "agent error")[:200])
    return reply or "Sorry, I didn't catch that."


def _wa_owner_jid() -> Optional[str]:
    """Enrique's personal WhatsApp jid, derived from WHATSAPP_ALLOWED_USERS
    (the number that talks to the JARVIS gateway bot)."""
    raw = _env_value("WHATSAPP_ALLOWED_USERS") or ""
    num = _re.sub(r"[^0-9]", "", raw.split(",")[0])
    return f"{num}@s.whatsapp.net" if num else None


def _whatsapp_deliver(answer: str, question: str) -> bool:
    """Deliver a delegated answer to Enrique's WhatsApp via the gateway bridge
    (loopback POST /send). Best-effort: returns True only on a confirmed send,
    never raises."""
    jid = _wa_owner_jid()
    answer = (answer or "").strip()
    if not jid or not answer:
        return False
    q = " ".join((question or "").split())[:200].strip()
    body = f"\U0001F399️ JARVIS — you asked:\n“{q}”\n\n{answer}" if q else answer
    payload = json.dumps({"chatId": jid, "message": body}).encode("utf-8")
    req = urllib.request.Request(
        _WA_BRIDGE_BASE + "/send", data=payload, method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=_WA_SEND_TIMEOUT_S) as resp:
            data = json.load(resp)
        return bool(data.get("success"))
    except Exception:  # noqa: BLE001 - delivery is best-effort
        return False


def _ensure_wa_promise(ack: str) -> str:
    """Guarantee the spoken ack tells Enrique the answer is coming to WhatsApp."""
    ack = (ack or "").strip() or _DELEGATE_ACK_DEFAULT
    if "whatsapp" not in ack.lower():
        if ack[-1] not in ".!?":
            ack += "."
        ack = f"{ack} {_WA_PROMISE}"
    return ack


def _light_clean_reply(text: str) -> str:
    """Light cleanup for a WhatsApp-bound answer: drop a leading role tag and
    trim, but keep markdown/lists/newlines (WhatsApp renders them fine, and the
    richer form is more useful than the speech-flattened voice reply)."""
    text = (text or "").strip()
    text = _re.sub(r"^(JARVIS|Assistant)\s*:\s*", "", text, flags=_re.IGNORECASE)
    return text.strip()


def _prune_pending(now: float) -> None:
    stale = [k for k, v in _voice_pending.items() if now - v.get("ts", 0.0) > _VOICE_PENDING_TTL_S]
    for k in stale:
        _voice_pending.pop(k, None)


def _delegate_worker(pending_id: str, conversation_id: str,
                     history: List[Tuple[str, str]], user_text: str) -> None:
    """Run the full Hermes turn off the request thread in background mode (it may
    spin up a typed team), deliver the finished answer to Enrique's WhatsApp,
    and record the result. Conversation history keeps a compact, voice-friendly
    version so the next spoken turn still has continuity."""
    try:
        answer = _full_hermes_reply(history, user_text, background=True)
        status = "done"
    except Exception:  # noqa: BLE001
        answer = "Sorry, sir — that one ran into an error."
        status = "error"
    delivered = _whatsapp_deliver(answer, user_text) if status == "done" else False
    now = time.time()
    # Durable job record: final status + (truncated) result, so a later
    # "what's the status" voice ask reads it from disk.
    prev = _voice_job_load(pending_id) or {}
    _voice_job_write(pending_id, {
        "job_id": pending_id,
        "conversation_id": conversation_id,
        "task": user_text,
        "status": status,
        "created_at": prev.get("created_at", now),
        "created_at_local": prev.get("created_at_local") or datetime.now(timezone.utc).isoformat(),
        "finished_at": now,
        "result": str(answer)[:600],
        "delivered": delivered,
    })
    hist_reply = (_voice_clean_reply(answer) or answer)[:400]
    with _voice_lock:
        sess = _voice_sessions.get(conversation_id) or {"turns": [], "ts": now}
        turns = list(sess["turns"])
        turns.append(("user", user_text))
        turns.append(("assistant", hist_reply))
        _voice_disk_append(conversation_id, "user", user_text, now)
        _voice_disk_append(conversation_id, "assistant", hist_reply, now)
        _voice_disk_touch_ts(conversation_id, now)
        _voice_sessions[conversation_id] = {"turns": turns[-(_VOICE_HISTORY_TURNS * 2):], "ts": now}
    with _voice_pending_lock:
        if pending_id in _voice_pending:
            _voice_pending[pending_id].update({
                "status": status, "reply": answer, "ts": now, "delivered": delivered,
            })


def _run_jarvis_turn(user_text: str, conversation_id: str) -> Dict[str, Any]:
    user_text = (user_text or "").strip()[:_VOICE_MAX_INPUT_CHARS]
    if not user_text:
        raise ValueError("empty transcript")
    now = time.time()
    with _voice_lock:
        _voice_prune(now)
        sess = _voice_sessions.get(conversation_id)
        if sess is None:
            # Not in the in-memory cache (fresh process or evicted) — restore
            # the thread from the on-disk log so memory survives restarts.
            sess = {"turns": _voice_disk_load(conversation_id), "ts": now}
            if sess["turns"]:
                _voice_sessions[conversation_id] = sess
        history = list(sess["turns"])[-(_VOICE_HISTORY_TURNS * 2):]
        t0 = time.time()
        # Status intent: answer "what's the status" straight from the durable
        # job records — deterministic, no model call, works after restarts.
        _tl = user_text.lower()
        if _re.search(r"\b(status|progress)\b", _tl) or \
                (_re.search(r"\bupdate\b", _tl) and _re.search(r"\b(any|what|got|on)\b", _tl)):
            reply = _voice_clean_reply(_voice_job_status_line())
            turns = list(sess["turns"])
            turns.append(("user", user_text))
            turns.append(("assistant", reply))
            _voice_disk_append(conversation_id, "user", user_text, t0)
            _voice_disk_append(conversation_id, "assistant", reply, time.time())
            _voice_disk_touch_ts(conversation_id, time.time())
            _voice_sessions[conversation_id] = {"turns": turns[-(_VOICE_HISTORY_TURNS * 2):], "ts": time.time()}
            return {"reply": reply, "took_ms": int((time.time() - t0) * 1000), "source": "status"}
        fast = _zai_fast(history, user_text)
        if fast is not None and "DELEGATE:" not in fast.upper():
            # Direct conversational answer — the fast, common case (~1.5s).
            # Voice turns never ask clarifying questions: a clarification-looking
            # fast reply is pushed to answer with a best guess instead.
            reply0 = _voice_clean_reply(fast)
            if reply0 and _re.search(
                r"\b(clarif|could you (tell|specify|elaborate)|which one|what do you mean|"
                r"can you (be more |provide more )?(specific|detailed|clear))\b",
                reply0.lower(),
            ):
                reply0 = reply0.rstrip(".!? \n") + " — I went with my best guess, sir."
            reply = reply0 or "Sorry, I didn't catch that."
            turns = list(sess["turns"])
            turns.append(("user", user_text))
            turns.append(("assistant", reply))
            _voice_disk_append(conversation_id, "user", user_text, t0)
            _voice_disk_append(conversation_id, "assistant", reply, time.time())
            _voice_disk_touch_ts(conversation_id, time.time())
            _voice_sessions[conversation_id] = {"turns": turns[-(_VOICE_HISTORY_TURNS * 2):], "ts": time.time()}
            return {"reply": reply, "took_ms": int((time.time() - t0) * 1000), "source": "fast"}
        # DELEGATE (or fast unavailable): ack now, run the full agent in the
        # background, hand the browser a pending_id to poll for the real answer.
        if fast and "DELEGATE:" in fast.upper():
            _i = fast.upper().find("DELEGATE:")
            ack = fast[_i + 9:].strip() or _DELEGATE_ACK_DEFAULT
        else:
            ack = _DELEGATE_ACK_DEFAULT
        ack = _ensure_wa_promise(ack)
        pending_id = uuid.uuid4().hex
        _t_now = time.time()
        with _voice_pending_lock:
            _prune_pending(_t_now)
            _voice_pending[pending_id] = {
                "status": "running", "reply": None, "ts": _t_now,
                "question": user_text, "started_at": _t_now, "delivered": False,
            }
        # Durable job record — survives dashboard restarts so "what's the
        # status" keeps answering long after the in-memory pending entry
        # expires. Written BEFORE the worker starts.
        _voice_job_write(pending_id, {
            "job_id": pending_id,
            "conversation_id": conversation_id,
            "task": user_text,
            "status": "running",
            "created_at": _t_now,
            "created_at_local": datetime.now(timezone.utc).isoformat(),
            "delivered": False,
        })
        threading.Thread(
            target=_delegate_worker,
            args=(pending_id, conversation_id, list(history), user_text),
            daemon=True,
        ).start()
        return {
            "reply": ack,
            "took_ms": int((time.time() - t0) * 1000),
            "source": "delegated",
            "pending_id": pending_id,
            "deliver": "whatsapp",
        }


def _eleven_tts_config() -> Tuple[str, str]:
    """Return (voice_id, model_id) from config.yaml, with safe fallbacks."""
    voice_id = _ELEVEN_DEFAULT_VOICE
    model_id = _ELEVEN_DEFAULT_MODEL
    try:
        import yaml  # pyyaml ships with Hermes

        cfg = yaml.safe_load(_CONFIG_PATH.read_text(encoding="utf-8")) or {}
        el = ((cfg.get("tts") or {}).get("elevenlabs") or {})
        voice_id = str(el.get("voice_id") or voice_id)
        model_id = str(el.get("model_id") or model_id)
    except Exception:
        pass
    return voice_id, model_id


def _eleven_tts(text: str) -> bytes:
    text = (text or "").strip()
    if len(text) > _VOICE_TTS_MAX_CHARS:
        cut = text[:_VOICE_TTS_MAX_CHARS]
        m = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
        if m > int(_VOICE_TTS_MAX_CHARS * 0.6):
            text = cut[: m + 1]
        else:
            sp = cut.rfind(" ")
            text = cut[:sp] if sp > 0 else cut
    if not text:
        raise ValueError("empty text")
    key = _env_value("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY not set")
    voice_id, model_id = _eleven_tts_config()
    url = f"{_ELEVEN_BASE}/text-to-speech/{urllib.parse.quote(voice_id)}?output_format=mp3_44100_128"
    body = json.dumps({
        "text": text,
        "model_id": model_id,
        "voice_settings": {
            "stability": 0.4,
            "similarity_boost": 0.8,
            "style": 0.0,
            "use_speaker_boost": True,
        },
    }).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={"xi-api-key": key, "Content-Type": "application/json", "Accept": "audio/mpeg"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:200]
        raise RuntimeError(f"ElevenLabs {exc.code}: {detail}")


@router.get("/api/control/voice/status")
async def control_voice_status():
    voice_id, model_id = _eleven_tts_config()
    return {
        "tts_ready": bool(_env_value("ELEVENLABS_API_KEY")),
        "stt": "browser",   # transcription happens client-side (Web Speech API)
        "voice_id": voice_id,
        "voice_model": model_id,
        "model": _current_model().get("short"),
    }


@router.post("/api/control/voice/converse")
async def control_voice_converse(payload: Dict[str, Any] = Body(...)):
    text = str(payload.get("text") or "")
    conv = str(payload.get("conversation_id") or "") or uuid.uuid4().hex
    try:
        result = await run_in_threadpool(_run_jarvis_turn, text, conv)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001 - surface a clean error to the mic UI
        raise HTTPException(status_code=502, detail=str(exc))
    return {"conversation_id": conv, "model": _current_model().get("short"), **result}


@router.get("/api/control/voice/result/{pending_id}")
async def control_voice_result(pending_id: str):
    with _voice_pending_lock:
        rec = _voice_pending.get(pending_id)
        if rec is None:
            return {"status": "unknown"}
        return {
            "status": rec.get("status", "running"),
            "reply": rec.get("reply"),
            "delivered": bool(rec.get("delivered")),
        }


_whisper_model = None
_whisper_lock = threading.Lock()


def _get_whisper():
    """Lazy-load a small CPU Whisper model (cached process-wide)."""
    global _whisper_model
    if _whisper_model is None:
        from faster_whisper import WhisperModel

        with _whisper_lock:
            if _whisper_model is None:
                _whisper_model = WhisperModel("base", device="cpu", compute_type="int8")
    return _whisper_model


@router.post("/api/control/voice/transcribe")
async def control_voice_transcribe(request: Request):
    """Server-side speech-to-text (mobile Safari has no Web Speech API).

    Accepts multipart audio (webm/ogg/mp4/wav) recorded via MediaRecorder and
    returns ``{"text": ...}`` transcribed with local faster-whisper.
    """
    ctype = request.headers.get("content-type", "")
    if "multipart/form-data" not in ctype:
        raise HTTPException(status_code=400, detail="expected multipart/form-data")
    try:
        form = await request.form()
        upload = form.get("audio")
        if upload is None:
            raise HTTPException(status_code=400, detail="missing audio field")
        data = await upload.read()
        if not data:
            raise HTTPException(status_code=400, detail="empty audio")
        suffix = ".webm"
        name = getattr(upload, "filename", "") or ""
        if "." in name:
            suffix = "." + name.rsplit(".", 1)[1][:8]
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(data)
            tmp_path = tmp.name
        try:

            def _transcribe():
                model = _get_whisper()
                segments, _info = model.transcribe(tmp_path, vad_filter=True)
                return " ".join(s.text.strip() for s in segments).strip()

            text = await run_in_threadpool(_transcribe)
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        return {"text": text}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"transcription failed: {exc}")


@router.post("/api/control/voice/tts")
async def control_voice_tts(payload: Dict[str, Any] = Body(...)):
    text = str(payload.get("text") or "")
    try:
        audio = await run_in_threadpool(_eleven_tts, text)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return Response(content=audio, media_type="audio/mpeg", headers={"Cache-Control": "no-store"})


# ── JARVIS message dispatcher: thread board (read-only) ──────────────────────
_DISPATCH_DB = os.environ.get("JARVIS_LEDGER_DB") or os.path.expanduser("~/.hermes/jarvis_dispatch.db")
_DISPATCH_UNSETTLED = ("open", "classified", "in_progress", "responded")


@router.get("/api/control/dispatch/board")
async def control_dispatch_board():
    """Live obligation board grouped by work-thread, read from the dispatcher ledger."""
    cached = _cached("dispatch_board")
    if cached is not None:
        return cached
    out: Dict[str, Any] = {"generated_at": _now_iso(), "counts": {}, "threads": [],
                           "unclassified": [], "available": False, "error": None}
    try:
        if not os.path.exists(_DISPATCH_DB):
            out["error"] = "ledger not initialised yet"
            return _set_cached("dispatch_board", out, 5.0)
        con = sqlite3.connect(f"file:{_DISPATCH_DB}?mode=ro", uri=True)
        con.row_factory = sqlite3.Row
        now = time.time()
        out["counts"] = {r["status"]: r["n"] for r in
                         con.execute("SELECT status, COUNT(*) n FROM obligations GROUP BY status")}
        rows = con.execute(
            "SELECT id,thread,status,thread_confidence,actionable,source_kind,message,"
            "created_at,nudge_count FROM obligations WHERE status IN (?,?,?,?) "
            "ORDER BY created_at DESC", _DISPATCH_UNSETTLED,
        ).fetchall()
        titles: Dict[str, Dict[str, Any]] = {}
        try:
            for t in con.execute("SELECT slug,title,project,status FROM threads"):
                titles[t["slug"]] = {"title": t["title"], "project": t["project"], "status": t["status"]}
        except Exception:
            pass
        tmap: Dict[str, List[Dict[str, Any]]] = {}
        for r in rows:
            slug = r["thread"] or "(unclassified)"
            tmap.setdefault(slug, []).append({
                "id": r["id"], "status": r["status"], "confidence": r["thread_confidence"],
                "actionable": r["actionable"], "source_kind": r["source_kind"],
                "message": (r["message"] or "")[:200], "nudge_count": r["nudge_count"],
                "ago_seconds": int(now - r["created_at"]) if r["created_at"] else None,
            })
        threads: List[Dict[str, Any]] = []
        for slug, items in tmap.items():
            if slug == "(unclassified)":
                out["unclassified"] = items
                continue
            meta = titles.get(slug, {})
            threads.append({
                "slug": slug, "title": meta.get("title") or slug,
                "project": meta.get("project") or "", "status": meta.get("status") or "active",
                "open_count": sum(1 for i in items if i["status"] in ("open", "classified", "in_progress")),
                "items": items,
            })
        # ago_seconds is None for rows with a null created_at; sort keys must
        # all be ints or the comparison itself raises TypeError (which the
        # handler below would swallow, blanking the whole board).
        threads.sort(key=lambda t: (t["items"][0]["ago_seconds"]
                                    if t["items"] and t["items"][0]["ago_seconds"] is not None
                                    else 1_000_000))
        con.close()
        out["threads"] = threads
        out["available"] = True
    except Exception as e:  # never break the dashboard
        out["error"] = str(e)
    return _set_cached("dispatch_board", out, 5.0)


@router.post("/api/control/work/{work_id}/chat")
async def control_work_chat(work_id: str, payload: Dict[str, Any] = Body(...)):
    """Per-task thread: a brief JARVIS reply about a Current Work item.
    Reuses the in-process Z.AI conversational turn; thread continuity is kept
    by conversation id (``work-<id>``)."""
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty message")
    title = str(payload.get("title") or "").strip()
    # Ground the reply in the item's real conversation (last few turns) so
    # "keep chatting" is informed by what the user is looking at.
    transcript = ""
    try:
        tail = (_work_history(work_id).get("messages") or [])[-8:]
        lines: List[str] = []
        for m in tail:
            role = m.get("role")
            if role == "tool":
                lines.append(f"[tool {m.get('tool_name')}] {(m.get('text') or '')[:180]}")
            elif role == "user":
                if m.get("text"):
                    lines.append(f"User: {m['text'][:220]}")
            else:
                if m.get("text"):
                    lines.append(f"JARVIS: {m['text'][:220]}")
                for c in m.get("tool_calls") or []:
                    lines.append(f"[calls {c.get('name')}] {(c.get('args') or '')[:120]}")
        if lines:
            transcript = "\nRecent activity on this item:\n" + "\n".join(lines) + "\n"
    except Exception:  # noqa: BLE001 - grounding is best-effort
        transcript = ""
    ctx = f"[Discussing a Control Center work item (id {work_id}"
    if title:
        ctx += f', "{title}"'
    ctx += "). Answer briefly and directly"
    ctx += ", grounded in the activity below.]\n" if transcript else ".]\n"
    ctx += transcript
    conv = "work-" + work_id
    try:
        result = await run_in_threadpool(_run_jarvis_turn, ctx + text, conv)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001 - surface a clean error to the UI
        raise HTTPException(status_code=502, detail=str(exc))
    return {"reply": result.get("reply") or result.get("text") or ""}


# --- Full conversation (messages + tool calls) for a Current Work item -------
_WORK_HISTORY_MAX_MSGS = 140
_WORK_HISTORY_MAX_CHARS = 1400


def _cc_shorten(s: Any, n: int) -> str:
    s = s if isinstance(s, str) else str(s)
    s = s.strip()
    return s if len(s) <= n else s[: n - 1].rstrip() + "…"


def _parse_tool_calls(tc: Any) -> List[Dict[str, str]]:
    """Normalize a stored ``tool_calls`` JSON blob to [{name, args}]."""
    try:
        arr = json.loads(tc)
    except (ValueError, TypeError):
        return []
    calls: List[Dict[str, str]] = []
    for c in arr if isinstance(arr, list) else []:
        if not isinstance(c, dict):
            continue
        fn = c.get("function") or {}
        name = fn.get("name") or c.get("name") or "tool"
        args = fn.get("arguments")
        if args is None:
            args = c.get("arguments") or ""
        if isinstance(args, (dict, list)):
            args = json.dumps(args, ensure_ascii=False)
        calls.append({"name": str(name), "args": _cc_shorten(" ".join(str(args).split()), 260)})
    return calls


def _tool_result_preview(content: str) -> str:
    """Tool results are usually JSON payloads — surface the useful part."""
    s = (content or "").strip()
    if s[:1] in ("{", "["):
        try:
            j = json.loads(s)
        except ValueError:
            return s
        if isinstance(j, dict):
            for k in ("output", "content", "result", "text", "stdout", "error", "message", "status"):
                v = j.get(k)
                if v not in (None, "", [], {}):
                    return v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
            return json.dumps(j, ensure_ascii=False)
        return json.dumps(j, ensure_ascii=False)
    return s


def _work_history(work_id: str) -> Dict[str, Any]:
    """Full stored conversation for a Current Work item: user/assistant text and
    the tool calls + tool results in between, read-only from state.db."""
    out: Dict[str, Any] = {"available": False, "session_id": None, "messages": []}
    wid = (work_id or "").strip()
    if not wid:
        return out
    try:
        uri = f"file:{_STATE_DB_PATH}?mode=ro"
        conn = sqlite3.connect(uri, uri=True, timeout=2.0)
        conn.row_factory = sqlite3.Row
    except Exception:  # noqa: BLE001
        return out
    try:
        sid: Optional[str] = None
        # Resolve the session id: exact, then prefix (cron/truncated ids), then
        # substring — Current Work ids come from sessions (full) and delegations
        # (truncated), and cron sessions embed the job id.
        for q, arg in (
            ("SELECT id FROM sessions WHERE id = ? LIMIT 1", wid),
            ("SELECT id FROM sessions WHERE id LIKE ? ORDER BY last_activity_at DESC LIMIT 1", wid + "%"),
            ("SELECT id FROM sessions WHERE id LIKE ? ORDER BY last_activity_at DESC LIMIT 1", "%" + wid + "%"),
        ):
            try:
                r = conn.execute(q, (arg,)).fetchone()
            except sqlite3.Error:
                r = None
            if r:
                sid = r["id"]
                break
        if not sid:
            try:
                r = conn.execute(
                    "SELECT session_id AS id FROM messages "
                    "WHERE session_id = ? OR session_id LIKE ? "
                    "ORDER BY timestamp DESC LIMIT 1",
                    (wid, wid + "%"),
                ).fetchone()
                if r:
                    sid = r["id"]
            except sqlite3.Error:
                pass
        if not sid:
            conn.close()
            return out
        rows = conn.execute(
            "SELECT role, content, tool_calls, tool_name, timestamp FROM messages "
            "WHERE session_id = ? AND COALESCE(active, 1) = 1 "
            "ORDER BY timestamp ASC",
            (sid,),
        ).fetchall()
    except sqlite3.Error:
        conn.close()
        return out
    conn.close()

    msgs: List[Dict[str, Any]] = []
    for r in rows:
        role = r["role"] or "assistant"
        content = (r["content"] or "").strip()
        entry: Dict[str, Any] = {"role": role, "ts": r["timestamp"]}
        if role == "tool":
            entry["tool_name"] = r["tool_name"] or "tool"
            preview = _tool_result_preview(content)
            entry["text"] = _cc_shorten(preview, _WORK_HISTORY_MAX_CHARS)
        else:
            if content:
                entry["text"] = _cc_shorten(content, _WORK_HISTORY_MAX_CHARS)
            if r["tool_calls"]:
                calls = _parse_tool_calls(r["tool_calls"])
                if calls:
                    entry["tool_calls"] = calls
            if not entry.get("text") and not entry.get("tool_calls"):
                continue  # empty assistant frame with nothing to show
        msgs.append(entry)
    if len(msgs) > _WORK_HISTORY_MAX_MSGS:
        msgs = msgs[-_WORK_HISTORY_MAX_MSGS:]
    out["available"] = True
    out["session_id"] = sid
    out["messages"] = msgs
    out["total"] = len(rows)
    return out


@router.get("/api/control/work/{work_id}/history")
async def control_work_history(work_id: str):
    return await run_in_threadpool(_work_history, work_id)


@router.post("/api/control/project/task")
async def control_project_task(payload: Dict[str, Any] = Body(...)):
    """Start a task on a project from the knowledge map: hand JARVIS an
    instruction scoped to the project. JARVIS acts or kicks off the work and
    returns a short reply. Keeps a per-project thread (``project-<name>``)."""
    project = str(payload.get("project") or "").strip()
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty task")
    ctx = ""
    if project:
        ctx = (
            f'[New task for the project "{project}", opened from the Control Center map. '
            f"Take the action or kick off the work (delegate if it is heavy); reply briefly.]\n"
        )
    slug = _re.sub(r"[^A-Za-z0-9_-]", "", project)[:48] or "adhoc"
    conv = "project-" + slug
    try:
        result = await run_in_threadpool(_run_jarvis_turn, ctx + text, conv)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc))
    return {"reply": result.get("reply") or result.get("text") or ""}
