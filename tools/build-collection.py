#!/usr/bin/env python3
"""Build store/collection.json from Wikimedia Commons + Bikez.

Walks manufacturer categories on Commons, picks one CC-licensed whole-bike
photograph per model, resolves displacement/category/URL on Bikez, writes
3:2 webp + 400w thumbs under store/img/collection/, appends CREDITS.md.

Idempotent. Parallelizable per manufacturer:

    python tools/build-collection.py --make Honda
    python tools/build-collection.py --merge --contact-sheet
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from html import unescape
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
COLL_DIR = ROOT / "store" / "img" / "collection"
CREDITS = ROOT / "store" / "CREDITS.md"
COLLECTION_JSON = ROOT / "store" / "collection.json"
CONTACT_SHEET = ROOT / ".git" / "sdd" / "reports" / "P2-collection-contact.png"
REPORT_REJECTS = ROOT / ".git" / "sdd" / "reports" / "_p2-rejects.json"

UA = "HandyBookCollection/1.0 (https://github.com/handy-book; motorcycle catalogue)"
CACHE = Path(tempfile.gettempdir()) / "hb-collection"
SRC_CACHE = CACHE / "src"
SHARD_DIR = CACHE / "shards"
BIKEZ_CACHE = CACHE / "bikez"
CAT_CACHE = CACHE / "cats"
META_DIR = CACHE / "meta"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WEBP_Q = 82
THUMB_W = 400
ASPECT = 3 / 2
MIN_W = 1200
HTTP_TIMEOUT = 45

Image.MAX_IMAGE_PIXELS = 40_000_000

MAKES: list[tuple[str, str, int]] = [
    # display make, Commons category, max models
    ("Honda", "Category:Honda motorcycles", 48),
    ("Yamaha", "Category:Yamaha motorcycles", 48),
    ("Kawasaki", "Category:Kawasaki motorcycles", 40),
    ("Suzuki", "Category:Suzuki motorcycles", 40),
    ("Ducati", "Category:Ducati motorcycles", 28),
    ("Triumph", "Category:Triumph motorcycles", 28),
    ("BMW", "Category:BMW motorcycles", 32),
    ("Harley-Davidson", "Category:Harley-Davidson motorcycles", 28),
    ("KTM", "Category:KTM motorcycles", 22),
    ("Aprilia", "Category:Aprilia motorcycles", 18),
    ("Moto Guzzi", "Category:Moto Guzzi motorcycles", 16),
    ("Royal Enfield", "Category:Royal Enfield motorcycles", 16),
    ("MV Agusta", "Category:MV Agusta motorcycles", 14),
    ("Husqvarna", "Category:Husqvarna motorcycles", 12),
    ("Indian", "Category:Indian motorcycles", 14),
    ("Piaggio", "Category:Piaggio vehicles", 8),
    ("Vespa", "Category:Vespa scooters", 8),
]

SKIP_BRANCH = re.compile(
    r"(scooters?$|mopeds?|underbones?|\batvs?\b|quads?|side-?by-?side|"
    r"motorcycle parts|\bengines\b|\blogos?\b|\briders?\b|unidentified|"
    r"\bconcept\b|\bpolice\b|racing motorcycles|\bin competition\b|"
    r"models of |tamiya|diecast|scale models|"
    r"by country|by decade|by year|by model year|by brand|"
    r"salon de|motor show|auto show|motodays|"
    r"museums?|communication plaza|factories|assembly|"
    r"advertis|drawings?|diagrams?|posters?|"
    r" motorcycles in | scooters in | vehicles in |"
    r"with sidecar|military |"
    r"hero honda|\bhm motorcycles\b|moriwaki|magni-honda|"
    r"people |clubs?|dealers?|"
    r"sport bikes|off-road motorcycles|dual purpose|electric motorcycles|"
    r"supermoto motorcycles|touring motorcycles|"
    r"^(category:)?(19[5-9]\d|20[0-2]\d)\b)",
    re.I,
)

REJECT_NAME = re.compile(
    r"(logo|diagram|drawing|sketch|icon|badge|blueprint|cutaway|"
    r"vector|\.svg|render|cgi|3d.?model|screenshot|video.?game|"
    r"interior|dashboard|cockpit|instrument cluster|"
    r"engine only|engine bay|piston|crankcase|"
    r"close-?up|closeup|macro|detail of|"
    r"wreck|crash|burned|scrap|dismantl|"
    r"\btoy\b|lego|tamiya|hot wheels|diecast|miniature|scale model|"
    r"line[- ]?up|several motorcycles|group of motorcycles|"
    r"helmet only|rider portrait)",
    re.I,
)

YEAR_RE = re.compile(r"\b(19[5-9]\d|20[0-2]\d)\b")
CC_RE = re.compile(
    r"\b(\d{2,4}(?:\.\d+)?)\s*(?:cc|cm³|cm3|cm\^3|c\.c\.)\b", re.I
)

JUNK_MODEL = re.compile(
    r"(mototrans|bimota|aermacchi|bonhams|panafina|24-hores|"
    r"hispania|mini2|tamiya|diecast|salon de|motodays|"
    r"harley-davidson harley-davidson|paris-bonhams)",
    re.I,
)

NICKNAMES = {
    "cb650r": ["neo sports cafe", "cb 650 r"],
    "mt-07": ["mt07", "fz-07", "fz07", "mt 07"],
    "z650": ["z 650"],
    "sv650": ["sv 650"],
    "yzf-r7": ["r7", "yzf r7", "yamaha r7"],
    "yzf-r1": ["r1", "yzf r1"],
    "yzf-r6": ["r6", "yzf r6"],
    "cbr1000rr": ["fireblade", "cbr1000"],
    "cbr600rr": ["cbr600"],
    "gold wing": ["goldwing", "gl1800"],
    "africa twin": ["crf1100l", "crf1000l"],
    "hayabusa": ["gsx1300r", "busa"],
    "ninja zx-10r": ["zx10r", "zx-10r"],
    "ninja zx-6r": ["zx6r", "zx-6r"],
    "panigale v4": ["panigale", "v4"],
    "monster": ["ducati monster"],
    "bonneville": ["bonnie"],
    "street triple": ["street triple rs"],
    "sportster": ["forty eight", "iron 883"],
    "fat boy": ["fatboy"],
    "r 1250 gs": ["r1250gs", "gs"],
    "duke": ["ktm duke"],
    "super duke": ["1290 super duke"],
}

FLAGSHIPS = [
    {
        "id": "honda-cb650r-2021",
        "make": "Honda",
        "model": "CB650R",
        "year": 2021,
        "years": [2019, 2020, 2021, 2022, 2023],
        "cc": 649,
        "category": "Naked bike",
        "aliases": ["cb650r", "cb 650 r", "cb650", "honda cb650r"],
        "bikez": "https://bikez.com/motorcycles/honda_cb650r_2021.php",
        "manualId": "honda-cb650r-2021-om",
        "reuse": "store/img/bikes/honda-cb650r-2021",
        "commons": "File:Honda CB650R Motorcycle 2021.jpg",
        "author": "Captainmorlypogi1959",
        "license": "CC BY-SA 4.0",
        "source": "https://commons.wikimedia.org/wiki/File:Honda_CB650R_Motorcycle_2021.jpg",
        "title": "Honda CB650R Motorcycle 2021.jpg",
    },
    {
        "id": "yamaha-mt-07-2021",
        "make": "Yamaha",
        "model": "MT-07",
        "year": 2021,
        "years": [2021, 2022, 2023, 2024],
        "cc": 689,
        "category": "Naked bike",
        "aliases": ["mt-07", "mt07", "mt 07", "yamaha mt-07", "fz-07"],
        "bikez": "https://bikez.com/motorcycles/yamaha_mt-07_2021.php",
        "manualId": "yamaha-mt-07-2021-om",
        "reuse": "store/img/bikes/yamaha-mt-07-2021",
        "commons": "File:2021 Black Yamaha MT-07.jpg",
        "author": "PackMecEng",
        "license": "CC BY-SA 4.0",
        "source": "https://commons.wikimedia.org/wiki/File:2021_Black_Yamaha_MT-07.jpg",
        "title": "2021 Black Yamaha MT-07.jpg",
    },
    {
        "id": "kawasaki-z650-2020",
        "make": "Kawasaki",
        "model": "Z650",
        "year": 2020,
        "years": [2020, 2021, 2022, 2023],
        "cc": 649,
        "category": "Naked bike",
        "aliases": ["z650", "z 650", "kawasaki z650"],
        "bikez": "https://bikez.com/motorcycles/kawasaki_z650_2020.php",
        "manualId": "kawasaki-z650-2020-om",
        "reuse": "store/img/bikes/kawasaki-z650-2020",
        "commons": "File:Kawasaki Z650 schwarz 2020.jpg",
        "author": "Gamemaster669",
        "license": "CC BY-SA 3.0",
        "source": "https://commons.wikimedia.org/wiki/File:Kawasaki_Z650_schwarz_2020.jpg",
        "title": "Kawasaki Z650 schwarz 2020.jpg",
    },
    {
        "id": "suzuki-sv650-2019",
        "make": "Suzuki",
        "model": "SV650",
        "year": 2019,
        "years": [2017, 2018, 2019, 2020, 2021, 2022],
        "cc": 645,
        "category": "Naked bike",
        "aliases": ["sv650", "sv 650", "suzuki sv650"],
        "bikez": "https://bikez.com/motorcycles/suzuki_sv650_2019.php",
        "manualId": "suzuki-sv650-2019-om",
        "reuse": "store/img/bikes/suzuki-sv650-2019",
        "commons": "File:SV 650 AL7.jpg",
        "author": "Highbrow",
        "license": "CC BY-SA 4.0",
        "source": "https://commons.wikimedia.org/wiki/File:SV_650_AL7.jpg",
        "title": "SV 650 AL7.jpg",
    },
    {
        "id": "yamaha-yzf-r7-2022",
        "make": "Yamaha",
        "model": "YZF-R7",
        "year": 2022,
        "years": [2022, 2023, 2024, 2025],
        "cc": 689,
        "category": "Sport",
        "aliases": ["yzf-r7", "yzf r7", "r7", "yamaha r7"],
        "bikez": "https://bikez.com/motorcycles/yamaha_yzf-r7_2022.php",
        "manualId": "yamaha-yzf-r7-2022-om",
        "commons": "File:2021 Yamaha YZF-R7.jpg",
        "category_hint": "Category:Yamaha YZF-R7 (2021)",
    },
]

print_lock = threading.Lock()
commons_lock = threading.Lock()
bikez_lock = threading.Lock()
last_commons = 0.0
last_bikez = 0.0
commons_sema = threading.Semaphore(2)


def log(msg: str) -> None:
    with print_lock:
        print(msg, flush=True)


def polite_pause(kind: str = "commons") -> None:
    global last_commons, last_bikez
    interval = 0.45 if kind == "commons" else 0.18
    lock = commons_lock if kind == "commons" else bikez_lock
    with lock:
        last = last_commons if kind == "commons" else last_bikez
        now = time.time()
        wait = interval - (now - last)
        if wait > 0:
            time.sleep(wait)
        if kind == "commons":
            last_commons = time.time()
        else:
            last_bikez = time.time()


def request(url: str, timeout: int = HTTP_TIMEOUT, retries: int = 5, kind: str = "commons") -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "Referer": "https://commons.wikimedia.org/"
            if "wikimedia" in url
            else "https://bikez.com/",
        },
    )
    last_err: Exception | None = None
    for attempt in range(retries):
        polite_pause(kind)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code in (404, 410):
                raise
            delay = 8.0 * (attempt + 1) if e.code == 429 else 1.4 * (attempt + 1)
            log(f"  HTTP {e.code} retry {attempt + 1} in {delay:.0f}s {url[:80]}")
            time.sleep(delay)
        except Exception as e:
            last_err = e
            time.sleep(1.4 * (attempt + 1))
    raise RuntimeError(f"request failed {url}: {last_err}")


def commons_api(params: dict) -> dict:
    params = dict(params)
    params.setdefault("format", "json")
    params.setdefault("maxlag", "5")
    url = COMMONS_API + "?" + urllib.parse.urlencode(params)
    with commons_sema:
        return json.loads(request(url, kind="commons"))


def strip_html(raw: str) -> str:
    raw = unescape(raw or "")
    raw = re.sub(r"<[^>]+>", " ", raw)
    return re.sub(r"\s+", " ", raw).strip()


def license_ok(name: str) -> bool:
    n = (name or "").lower().replace("_", " ").strip()
    if not n:
        return False
    if re.search(r"noncommercial|\bnc\b|no deriv|\bnd\b", n):
        return False
    if "cc0" in n or "cc zero" in n or n.startswith("pd") or "public domain" in n:
        return True
    if re.match(r"cc-?by(-?sa)?\b", n) or n.startswith("cc by"):
        return True
    return False


def slug_token(text: str) -> str:
    s = (text or "").lower().strip()
    s = s.replace("&", "and")
    s = re.sub(r"[\s_]+", "-", s)
    s = re.sub(r"[^a-z0-9-]", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def bike_id(make: str, model: str, year: int) -> str:
    return f"{slug_token(make)}-{slug_token(model)}-{year}"


def aliases_for(make: str, model: str) -> list[str]:
    m = model.lower().strip()
    compact = re.sub(r"[- ]+", "", m)
    spaced = m.replace("-", " ")
    hyphened = m.replace(" ", "-")
    out = [m, compact, spaced, hyphened, f"{make.lower()} {m}", f"{make.lower()} {compact}"]
    for key, extra in NICKNAMES.items():
        if key in m or m in key:
            out.extend(extra)
    seen: set[str] = set()
    uniq: list[str] = []
    for a in out:
        a = re.sub(r"\s+", " ", a).strip()
        if a and a not in seen:
            seen.add(a)
            uniq.append(a)
    return uniq[:12]


def cache_path(key: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", key)[:180]
    return SRC_CACHE / safe


def skip_category(title: str) -> bool:
    t = title.replace("Category:", "").strip()
    if SKIP_BRANCH.search(t) or SKIP_BRANCH.search(title):
        return True
    if re.match(r"^(19[5-9]\d|20[0-2]\d)\b", t):
        return True
    if re.search(r"\b(19[5-9]\d|20[0-2]\d) (motorcycles|scooters)\b", t, re.I):
        return True
    return False


def model_from_category(cat: str, make: str) -> str | None:
    name = cat.replace("Category:", "").strip()
    make_l = make.lower()
    name_l = name.lower()
    if name_l.startswith(make_l):
        rest = name[len(make) :].strip(" -")
    else:
        rest = name
    rest = re.sub(r"\s+\(\d{4}\)\s*$", "", rest).strip()
    rest = re.sub(r"\s+motorcycles?$", "", rest, flags=re.I).strip()
    rest = re.sub(r"\s+scooters?$", "", rest, flags=re.I).strip()
    if not rest or rest.lower() == make_l:
        return None
    if skip_category(rest):
        return None
    return rest


def is_series_parent(model: str, subcat_count: int) -> bool:
    token = re.sub(r"[^A-Za-z0-9]", "", model)
    if subcat_count >= 3 and not re.search(r"\d", model) and len(token) <= 4:
        return True
    if subcat_count >= 8 and not re.search(r"\d", model):
        return True
    return False


def category_members(title: str) -> tuple[list[str], list[str]]:
    subcats: list[str] = []
    files: list[str] = []
    cont: str | None = None
    while True:
        params = {
            "action": "query",
            "list": "categorymembers",
            "cmtitle": title,
            "cmlimit": "100",
            "cmprop": "title",
        }
        if cont:
            params["cmcontinue"] = cont
        data = commons_api(params)
        for m in data.get("query", {}).get("categorymembers", []):
            t = m["title"]
            if t.startswith("Category:"):
                subcats.append(t)
            elif t.startswith("File:"):
                files.append(t)
        cont = (data.get("continue") or {}).get("cmcontinue")
        if not cont:
            break
    return subcats, files


def file_infos(titles: list[str]) -> list[dict]:
    out: list[dict] = []
    for i in range(0, len(titles), 40):
        chunk = titles[i : i + 40]
        data = commons_api(
            {
                "action": "query",
                "titles": "|".join(chunk),
                "prop": "imageinfo",
                "iiprop": "url|extmetadata|size|mime",
                "iiurlwidth": "3840",
            }
        )
        pages = data.get("query", {}).get("pages", {})
        for page in pages.values():
            if "imageinfo" not in page:
                continue
            title = page.get("title") or ""
            ii = page["imageinfo"][0]
            em = ii.get("extmetadata") or {}

            def meta(key: str) -> str:
                return strip_html((em.get(key) or {}).get("value") or "")

            out.append(
                {
                    "title": title,
                    "author": meta("Artist") or meta("Credit") or "Unknown",
                    "license": meta("LicenseShortName") or meta("License") or "",
                    "source": ii.get("descriptionurl")
                    or "https://commons.wikimedia.org/wiki/"
                    + urllib.parse.quote(title.replace(" ", "_")),
                    "url": ii.get("url"),
                    "thumburl": ii.get("thumburl"),
                    "width": int(ii.get("width") or 0),
                    "height": int(ii.get("height") or 0),
                    "mime": ii.get("mime") or "",
                    "description": meta("ImageDescription") or meta("ObjectName") or "",
                    "datetime": meta("DateTimeOriginal") or meta("DateTime") or "",
                }
            )
    return out


def years_in(*texts: str) -> list[int]:
    found: list[int] = []
    for t in texts:
        for m in YEAR_RE.findall(t or ""):
            y = int(m)
            if 1955 <= y <= 2026:
                found.append(y)
    return found


def score_photo(info: dict, make: str, model: str) -> float:
    title = info["title"]
    mime = info["mime"].lower()
    if not mime.startswith("image/"):
        return -1
    if mime in ("image/svg+xml", "image/gif", "image/tiff"):
        return -1
    if info["width"] < MIN_W:
        return -1
    if not license_ok(info["license"]):
        return -1
    blob = f"{title} {info.get('description', '')}"
    if REJECT_NAME.search(blob):
        return -1
    w, h = info["width"], info["height"]
    if h <= 0:
        return -1
    aspect = w / h
    if aspect < 1.15:
        return -1
    score = 10.0
    score += min(w / 400.0, 12)
    if 1.35 <= aspect <= 2.15:
        score += 8
    elif aspect > 2.6:
        score -= 4
    tl = title.lower()
    ml = model.lower()
    if ml and ml in tl:
        score += 6
    if make.lower() in tl:
        score += 2
    if any(k in tl for k in ("side", "left", "right", "profile", "3/4", "three-quarter")):
        score += 5
    if years_in(title):
        score += 3
    if any(k in blob.lower() for k in ("person", "people", "crowd", "parade")):
        score -= 3
    return score


def pick_photo(infos: list[dict], make: str, model: str) -> dict | None:
    ranked = []
    for info in infos:
        s = score_photo(info, make, model)
        if s > 0:
            ranked.append((s, info))
    if not ranked:
        return None
    ranked.sort(key=lambda x: x[0], reverse=True)
    return ranked[0][1]


def prefilter_files(files: list[str], make: str, model: str) -> list[str]:
    scored: list[tuple[float, str]] = []
    ml = model.lower()
    makel = make.lower()
    for title in files:
        blob = title.lower()
        if REJECT_NAME.search(blob):
            continue
        if not title.lower().endswith((".jpg", ".jpeg", ".png", ".webp")):
            continue
        score = 1.0
        if ml and ml in blob:
            score += 6
        if makel in blob:
            score += 2
        if years_in(title):
            score += 3
        if any(k in blob for k in ("side", "left", "right", "profile")):
            score += 4
        scored.append((score, title))
    scored.sort(key=lambda x: x[0], reverse=True)
    return [t for _, t in scored[:8]]


def walk_make(make: str, root_cat: str, limit: int | None = None) -> list[dict]:
    cache_file = CAT_CACHE / f"{slug_token(make)}.json"
    stop_after = limit or 90
    if cache_file.exists() and not os.environ.get("HB_REFRESH_CATS"):
        try:
            cached = json.loads(cache_file.read_text(encoding="utf-8"))
            if cached:
                log(f"  {make}: cached {len(cached)} model categories")
                return cached[:limit] if limit else cached
        except Exception:
            pass

    visited: set[str] = set()
    leaves: list[dict] = []
    queue: list[tuple[str, int]] = [(root_cat, 0)]
    while queue:
        if len(leaves) >= stop_after:
            break
        cat, depth = queue.pop(0)
        if cat in visited or depth > 3:
            continue
        visited.add(cat)
        if cat != root_cat and skip_category(cat):
            continue
        try:
            subcats, files = category_members(cat)
        except Exception as e:
            log(f"  skip {cat}: {e}")
            continue
        model = model_from_category(cat, make) if cat != root_cat else None
        child_ok = [s for s in subcats if not skip_category(s)]
        series = bool(model and is_series_parent(model, len(child_ok)))
        if model and files and not series:
            leaves.append({"category": cat, "make": make, "model": model, "files": files[:40]})
        if depth < 3:
            for sub in child_ok:
                if sub not in visited:
                    queue.append((sub, depth + 1))
        if len(visited) % 25 == 0:
            log(f"  {make}: walked {len(visited)} cats, {len(leaves)} model leaves")
        if len(visited) >= 140:
            break

    CAT_CACHE.mkdir(parents=True, exist_ok=True)
    cache_file.write_text(json.dumps(leaves, indent=0), encoding="utf-8")
    log(f"  {make}: {len(leaves)} model categories ({len(visited)} walked)")
    return leaves[:stop_after]


def bikez_slugs(model: str) -> list[str]:
    raw = model.lower().strip()
    raw = raw.replace("&", "and")
    raw = re.sub(r"[^a-z0-9\s_-]", "", raw)
    raw = re.sub(r"\s+", " ", raw).strip()
    spaced = raw.replace(" ", "_")
    nohy = spaced.replace("-", "_")
    compact = re.sub(r"[-_ ]+", "", raw)
    keep_hyphen = raw.replace(" ", "_")
    variants = [keep_hyphen, spaced, nohy, compact]
    if re.search(r"\d", raw):
        variants.append(re.sub(r"\s+", "", raw).replace("-", "_"))
        variants.append(re.sub(r"\s+", "", raw).replace("-", ""))
    out: list[str] = []
    seen: set[str] = set()
    for v in variants:
        v = re.sub(r"_+", "_", v).strip("_")
        if v and v not in seen:
            seen.add(v)
            out.append(v)
    return out[:3]


def load_bikez_index() -> dict[str, str]:
    path = CACHE / "bikez-index.json"
    if not path.exists():
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


_BIKEZ_INDEX: dict[str, str] | None = None
_BIKEZ_BY_MAKE: dict[str, list[tuple[str, int, str]]] | None = None


def bikez_index() -> dict[str, str]:
    global _BIKEZ_INDEX, _BIKEZ_BY_MAKE
    if _BIKEZ_INDEX is None:
        _BIKEZ_INDEX = load_bikez_index()
        prefixes = sorted(
            {
                make.lower().replace(" ", "_")
                for make, _, _ in MAKES
            }
            | {
                make.lower().replace(" ", "-")
                for make, _, _ in MAKES
            },
            key=len,
            reverse=True,
        )
        by_make: dict[str, list[tuple[str, int, str]]] = {}
        for key, url in _BIKEZ_INDEX.items():
            make_s = None
            rest = None
            for prefix in prefixes:
                if key.startswith(prefix + "_"):
                    make_s = prefix
                    rest = key[len(prefix) + 1 :]
                    break
            if not make_s or not rest:
                continue
            m = re.match(r"^(.+)_(\d{4})$", rest)
            if not m:
                continue
            model_s, year_s = m.group(1), int(m.group(2))
            by_make.setdefault(make_s, []).append((model_s, year_s, url))
        _BIKEZ_BY_MAKE = by_make
        log(f"bikez index {len(_BIKEZ_INDEX)} urls, {len(by_make)} makes")
    return _BIKEZ_INDEX


def parse_bikez_html(html: str, url: str) -> dict | None:
    if "engineDisplacement" not in html and '"category"' not in html:
        return None
    cat = None
    m = re.search(r'"category"\s*:\s*"([^"]+)"', html)
    if m:
        cat = unescape(m.group(1)).strip()
    cc = None
    m = re.search(
        r'"engineDisplacement"\s*:\s*\{\s*"value"\s*:\s*"([0-9.]+)"', html
    )
    if m:
        cc = int(round(float(m.group(1))))
    if cc is None:
        m = re.search(r"Displacement[^<]{0,80}?(\d{2,4}(?:\.\d+)?)\s*ccm", html, re.I)
        if m:
            cc = int(round(float(m.group(1))))
    if not cc:
        return None
    years = sorted(
        {
            int(y)
            for y in re.findall(r"_(\d{4})\.php", html)
            if 1955 <= int(y) <= 2026
        }
    )
    return {"cc": cc, "category": cat or "Motorcycle", "url": url, "years": years}


def fetch_bikez_url(url: str) -> dict | None:
    BIKEZ_CACHE.mkdir(parents=True, exist_ok=True)
    key = re.sub(r"[^a-z0-9._-]+", "_", url)[:180]
    cache_file = BIKEZ_CACHE / key
    html = None
    if cache_file.exists():
        html = cache_file.read_text(encoding="utf-8", errors="replace")
        if html.startswith("HTTP404"):
            return None
    else:
        try:
            raw = request(url, timeout=30, retries=2, kind="bikez")
            html = raw.decode("utf-8", "replace")
            cache_file.write_text(html, encoding="utf-8")
        except urllib.error.HTTPError as e:
            if e.code in (404, 410):
                cache_file.write_text("HTTP404", encoding="utf-8")
            return None
        except Exception:
            return None
    parsed = parse_bikez_html(html, url)
    return parsed


def match_bikez_index(make: str, model: str, year: int | None) -> list[str]:
    bikez_index()
    if not _BIKEZ_BY_MAKE:
        return []
    make_keys = [
        make.lower().replace(" ", "_"),
        make.lower().replace(" ", "-"),
        slug_token(make).replace("-", "_"),
    ]
    model_s = re.sub(r"[^a-z0-9]+", "_", model.lower()).strip("_")
    compact = re.sub(r"[^a-z0-9]+", "", model.lower())
    ranked: list[tuple[int, int, str]] = []
    seen_urls: set[str] = set()
    for mk in make_keys:
        for mslug, y, url in _BIKEZ_BY_MAKE.get(mk, []):
            mcompact = mslug.replace("-", "").replace("_", "")
            score = 0
            if mslug == model_s or mcompact == compact:
                score = 12
            elif compact and (compact == mcompact or compact in mcompact or mcompact in compact):
                score = 8 if abs(len(compact) - len(mcompact)) <= 3 else 5
            elif model_s and model_s in mslug:
                score = 4
            else:
                continue
            dy = abs(y - year) if year else 5
            if year:
                if dy == 0:
                    score += 5
                elif dy == 1:
                    score += 3
                elif dy == 2:
                    score += 1
                elif dy > 4:
                    continue
            if url in seen_urls:
                continue
            seen_urls.add(url)
            ranked.append((score, dy, url))
    ranked.sort(key=lambda t: (-t[0], t[1]))
    return [u for _, _, u in ranked[:4]]


def bikez_lookup(make: str, model: str, year: int | None) -> dict | None:
    urls = match_bikez_index(make, model, year)
    if not urls:
        make_slug = make.lower().replace(" ", "_")
        years = [year] if year else []
        if year:
            years.extend([year + 1, year - 1])
        for y in [y for y in years if y and 1955 <= y <= 2026][:3]:
            for ms in bikez_slugs(model)[:2]:
                urls.append(f"https://bikez.com/motorcycles/{make_slug}_{ms}_{y}.php")
    tried = set()
    for url in urls:
        if url in tried:
            continue
        tried.add(url)
        parsed = fetch_bikez_url(url)
        if parsed:
            y_from_url = None
            m = re.search(r"_(\d{4})\.php$", url)
            if m:
                y_from_url = int(m.group(1))
            parsed["year"] = y_from_url or year or parsed["years"][-1]
            if parsed["year"] not in parsed["years"]:
                parsed["years"] = sorted(set(parsed["years"] + [parsed["year"]]))
            return parsed
    return None


def cc_from_text(*texts: str) -> int | None:
    for t in texts:
        m = CC_RE.search(t or "")
        if m:
            val = float(m.group(1))
            if 49 <= val <= 2300:
                return int(round(val))
    return None


def to_rgb(im: Image.Image) -> Image.Image:
    if im.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
        bg.info = {}
        return bg
    rgb = im.convert("RGB")
    rgb.info = {}
    return rgb


def crop_aspect(im: Image.Image, aspect: float, anchor: str = "center") -> Image.Image:
    w, h = im.size
    current = w / h
    if abs(current - aspect) < 0.01:
        return im
    if current > aspect:
        new_w = int(round(h * aspect))
        left = (w - new_w) // 2
        return im.crop((left, 0, left + new_w, h))
    new_h = int(round(w / aspect))
    if anchor == "bottom":
        top = h - new_h
    elif anchor == "top":
        top = 0
    else:
        top = (h - new_h) // 2
    top = max(0, min(top, h - new_h))
    return im.crop((0, top, w, top + new_h))


def save_webp(im: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    im.save(path, "WEBP", quality=WEBP_Q, method=6)


def download_source(commons_title: str, info: dict) -> Path:
    SRC_CACHE.mkdir(parents=True, exist_ok=True)
    dest = cache_path(commons_title)
    if dest.exists() and dest.stat().st_size > 8_000:
        return dest
    urls = [u for u in (info.get("thumburl"), info.get("url")) if u]
    last_err = None
    for url in urls:
        try:
            dest.write_bytes(request(url, kind="commons"))
            if dest.stat().st_size > 8_000:
                return dest
        except Exception as e:
            last_err = e
            continue
    raise RuntimeError(f"download failed for {commons_title}: {last_err}")


def process_image(src: Path, bike_id_str: str) -> tuple[Path, Path, tuple[int, int]]:
    full_path = COLL_DIR / f"{bike_id_str}.webp"
    thumb_path = COLL_DIR / f"{bike_id_str}-thumb.webp"
    with Image.open(src) as raw:
        im = to_rgb(raw)
    im = crop_aspect(im, ASPECT, "center")
    w, h = im.size
    if w < MIN_W:
        raise RuntimeError(f"{bike_id_str} cropped width {w}px < {MIN_W}px")
    save_webp(im, full_path)
    th = int(round(THUMB_W / ASPECT))
    thumb = im.resize((THUMB_W, th), Image.Resampling.LANCZOS)
    save_webp(thumb, thumb_path)
    return full_path, thumb_path, (w, h)


def record_from_parts(
    *,
    ident: str,
    make: str,
    model: str,
    year: int,
    years: list[int],
    cc: int,
    category: str,
    aliases: list[str],
    bikez: str | None,
    manual_id: str | None,
    commons: str,
    author: str,
    license_name: str,
    source: str,
    title: str,
) -> dict:
    return {
        "bike": {
            "id": ident,
            "make": make,
            "model": model,
            "year": year,
            "years": years or [year],
            "cc": cc,
            "category": category,
            "aliases": aliases,
            "thumb": f"store/img/collection/{ident}-thumb.webp",
            "image": f"store/img/collection/{ident}.webp",
            "bikez": bikez,
            "manualId": manual_id,
        },
        "credits": {
            "title": title,
            "author": author,
            "license": license_name,
            "source": source,
            "commons": commons,
            "bikez": bikez or "",
        },
    }


def ensure_flagships() -> list[dict]:
    COLL_DIR.mkdir(parents=True, exist_ok=True)
    rows = []
    for item in FLAGSHIPS:
        ident = item["id"]
        full = COLL_DIR / f"{ident}.webp"
        thumb = COLL_DIR / f"{ident}-thumb.webp"
        if item.get("reuse"):
            src_full = ROOT / f"{item['reuse']}.webp"
            src_thumb = ROOT / f"{item['reuse']}-thumb.webp"
            if not src_full.exists():
                raise RuntimeError(f"missing reuse photo {src_full}")
            if not full.exists() or full.stat().st_size < 8_000:
                shutil.copy2(src_full, full)
            if not thumb.exists() or thumb.stat().st_size < 2_000:
                shutil.copy2(src_thumb, thumb)
            author = item["author"]
            license_name = item["license"]
            source = item["source"]
            title = item["title"]
            commons = item["commons"]
        else:
            commons = item["commons"]
            infos = file_infos([commons])
            if not infos:
                # fallback: pick from hinted category
                hint = item.get("category_hint") or "Category:Yamaha YZF-R7"
                _sub, files = category_members(hint)
                infos = file_infos(files[:40])
                photo = pick_photo(infos, item["make"], item["model"])
                if not photo:
                    raise RuntimeError(f"no photo for flagship {ident}")
            else:
                photo = infos[0]
                if photo["width"] < MIN_W or not license_ok(photo["license"]):
                    hint = item.get("category_hint") or "Category:Yamaha YZF-R7"
                    _sub, files = category_members(hint)
                    picked = pick_photo(file_infos(files[:40]), item["make"], item["model"])
                    if picked:
                        photo = picked
            if not full.exists() or full.stat().st_size < 8_000:
                src = download_source(photo["title"], photo)
                process_image(src, ident)
            author = photo["author"]
            license_name = photo["license"]
            source = photo["source"]
            title = photo["title"].replace("File:", "", 1)
            commons = photo["title"]
        rec = record_from_parts(
            ident=ident,
            make=item["make"],
            model=item["model"],
            year=item["year"],
            years=item["years"],
            cc=item["cc"],
            category=item["category"],
            aliases=item["aliases"],
            bikez=item["bikez"],
            manual_id=item["manualId"],
            commons=commons,
            author=author,
            license_name=license_name,
            source=source,
            title=title,
        )
        rows.append(rec)
        log(f"OK flagship {ident}")
    return rows


def write_sidecar(rec: dict) -> None:
    ident = rec["bike"]["id"]
    META_DIR.mkdir(parents=True, exist_ok=True)
    path = META_DIR / f"{ident}.json"
    path.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")


def recover_make(make: str) -> list[dict]:
    prefix = slug_token(make) + "-"
    rows: list[dict] = []
    META_DIR.mkdir(parents=True, exist_ok=True)
    for meta in META_DIR.glob(f"{prefix}*.json"):
        try:
            rec = json.loads(meta.read_text(encoding="utf-8"))
            img = COLL_DIR / f"{rec['bike']['id']}.webp"
            if img.exists() and img.stat().st_size > 8_000:
                rows.append(rec)
        except Exception:
            continue
    return rows


def process_leaf(leaf: dict) -> tuple[dict | None, str | None]:
    make = leaf["make"]
    model = leaf["model"]
    files = prefilter_files(leaf["files"], make, model) or leaf["files"][:10]
    try:
        infos = file_infos(files)
    except Exception as e:
        return None, f"{make} {model}: imageinfo {e}"
    photo = pick_photo(infos, make, model)
    if not photo:
        return None, f"{make} {model}: no eligible photo"
    title_years = years_in(photo["title"], leaf["category"])
    year_candidates = title_years or years_in(photo["description"]) or years_in(photo["datetime"])
    year = max(year_candidates) if year_candidates else None
    bikez = bikez_lookup(make, model, year)
    cc = None
    category = None
    bikez_url = None
    years = []
    if bikez:
        cc = bikez["cc"]
        category = bikez["category"]
        bikez_url = bikez["url"]
        year = bikez.get("year") or year
        years = bikez.get("years") or []
    if cc is None:
        cc = cc_from_text(photo["description"], photo["title"], leaf["category"])
    if year is None or cc is None:
        return None, f"{make} {model}: missing year/cc (year={year} cc={cc} bikez={bool(bikez)})"
    if not years:
        years = [year]
    elif year not in years:
        years = sorted(set(years + [year]))
    ident = bike_id(make, model, year)
    if ident in {f["id"] for f in FLAGSHIPS}:
        return None, f"{ident}: reserved flagship"
    full = COLL_DIR / f"{ident}.webp"
    try:
        if not full.exists() or full.stat().st_size < 8_000:
            src = download_source(photo["title"], photo)
            process_image(src, ident)
        else:
            thumb = COLL_DIR / f"{ident}-thumb.webp"
            if not thumb.exists():
                src = download_source(photo["title"], photo)
                process_image(src, ident)
    except Exception as e:
        return None, f"{ident}: image {e}"
    rec = record_from_parts(
        ident=ident,
        make=make,
        model=model,
        year=year,
        years=years,
        cc=cc,
        category=category or "Motorcycle",
        aliases=aliases_for(make, model),
        bikez=bikez_url,
        manual_id=None,
        commons=photo["title"],
        author=photo["author"],
        license_name=photo["license"],
        source=photo["source"],
        title=photo["title"].replace("File:", "", 1),
    )
    write_sidecar(rec)
    return rec, None


def process_make(make: str, root_cat: str, cap: int, limit: int | None = None) -> dict:
    SHARD_DIR.mkdir(parents=True, exist_ok=True)
    shard_path = SHARD_DIR / f"{slug_token(make)}.json"
    log(f"== {make} ==")
    records: list[dict] = recover_make(make)
    rejects: list[str] = []
    seen_ids: set[str] = {r["bike"]["id"] for r in records}
    seen_models: set[str] = {slug_token(r["bike"]["model"]) for r in records}
    if records:
        log(f"  {make}: recovered {len(records)} sidecars")

    def save() -> None:
        shard_path.write_text(
            json.dumps({"make": make, "records": records, "rejects": rejects[-200:]}, indent=0),
            encoding="utf-8",
        )

    if len(records) >= cap:
        save()
        log(f"== {make} done {len(records)} kept (already at cap) ==")
        return {"make": make, "records": records, "rejects": rejects}

    leaves = walk_make(make, root_cat, limit)
    leaves.sort(
        key=lambda L: (
            0 if re.search(r"\d", L["model"]) else 1,
            -len(L["files"]),
            L["model"],
        )
    )
    for leaf in leaves:
        if len(records) >= cap:
            break
        model = leaf["model"]
        if JUNK_MODEL.search(model):
            rejects.append(f"{make} {model}: junk name")
            continue
        model_key = slug_token(model)
        if model_key in seen_models:
            continue
        rec, reason = process_leaf(leaf)
        if rec is None:
            if reason:
                rejects.append(reason)
                if len(rejects) <= 8 or len(rejects) % 10 == 0:
                    log(f"skip {reason}")
            continue
        ident = rec["bike"]["id"]
        if ident in seen_ids:
            seen_models.add(model_key)
            continue
        seen_ids.add(ident)
        seen_models.add(model_key)
        records.append(rec)
        log(f"OK {ident}  {rec['bike'].get('cc')}cc  {rec['credits']['license']}")
        if len(records) % 3 == 0:
            save()
    save()
    log(f"== {make} done {len(records)} kept, {len(rejects)} rejected ==")
    return {"make": make, "records": records, "rejects": rejects}


def load_shards() -> list[dict]:
    rows: list[dict] = []
    seen: set[str] = set()
    if SHARD_DIR.exists():
        for p in sorted(SHARD_DIR.glob("*.json")):
            try:
                data = json.loads(p.read_text(encoding="utf-8"))
                for rec in data.get("records") or []:
                    ident = rec.get("bike", {}).get("id")
                    if ident and ident not in seen:
                        seen.add(ident)
                        rows.append(rec)
            except Exception:
                continue
    if META_DIR.exists():
        for p in META_DIR.glob("*.json"):
            try:
                rec = json.loads(p.read_text(encoding="utf-8"))
                ident = rec.get("bike", {}).get("id")
                if ident and ident not in seen:
                    seen.add(ident)
                    rows.append(rec)
            except Exception:
                continue
    return rows


def load_rejects() -> list[str]:
    out: list[str] = []
    if not SHARD_DIR.exists():
        return out
    for p in sorted(SHARD_DIR.glob("*.json")):
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
            out.extend(data.get("rejects") or [])
        except Exception:
            continue
    return out


def sort_bikes(bikes: list[dict]) -> list[dict]:
    def key(b: dict):
        return (b["make"].lower(), b["model"].lower(), b["year"], b["id"])

    return sorted(bikes, key=key)


def md_escape(text: str) -> str:
    return (text or "").replace("|", "\\|").replace("\n", " ").strip()


def append_credits(records: list[dict]) -> int:
    if not CREDITS.exists():
        raise RuntimeError("store/CREDITS.md missing — other agent owns the header")
    text = CREDITS.read_text(encoding="utf-8")
    existing = set(re.findall(r"`(store/img/collection/[^`]+)`", text))
    lines: list[str] = []
    added = 0
    if not text.endswith("\n"):
        lines.append("")
    for rec in records:
        bike = rec["bike"]
        cr = rec["credits"]
        for rel in (bike["image"], bike["thumb"]):
            if rel in existing:
                continue
            lines.append(
                "| `{file}` | {title} | {author} | {source} | {license} | {bikez} |".format(
                    file=rel,
                    title=md_escape(cr["title"]),
                    author=md_escape(cr["author"]),
                    source=cr["source"],
                    license=md_escape(cr["license"]),
                    bikez=cr.get("bikez") or "",
                )
            )
            existing.add(rel)
            added += 1
    if lines:
        CREDITS.write_text(text.rstrip() + "\n" + "\n".join(lines) + "\n", encoding="utf-8")
    return added


def write_collection(records: list[dict]) -> list[dict]:
    bikes = [r["bike"] for r in records]
    # de-dupe by id, prefer flagship / manualId
    by_id: dict[str, dict] = {}
    rec_by_id: dict[str, dict] = {}
    for rec in records:
        b = rec["bike"]
        prev = by_id.get(b["id"])
        if prev is None or (b.get("manualId") and not prev.get("manualId")):
            by_id[b["id"]] = b
            rec_by_id[b["id"]] = rec
    bikes = sort_bikes(list(by_id.values()))
    COLLECTION_JSON.write_text(
        json.dumps({"bikes": bikes}, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return [rec_by_id[b["id"]] for b in bikes]


def font(size: int) -> ImageFont.ImageFont:
    for path in (
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/calibri.ttf",
    ):
        if Path(path).exists():
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def build_contact_sheet(bikes: list[dict], dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    n = len(bikes)
    cols = 12 if n > 80 else 8
    cell_w, img_h, label_h = 160, 107, 22
    rows = (n + cols - 1) // cols if n else 1
    sheet = Image.new("RGB", (cols * cell_w, rows * (img_h + label_h)), (20, 20, 20))
    draw = ImageDraw.Draw(sheet)
    fnt = font(11)
    for i, bike in enumerate(bikes):
        r, c = divmod(i, cols)
        x, y = c * cell_w, r * (img_h + label_h)
        thumb = ROOT / bike["thumb"]
        try:
            with Image.open(thumb) as im:
                im = im.convert("RGB")
                im.thumbnail((cell_w, img_h), Image.Resampling.LANCZOS)
                px = x + (cell_w - im.size[0]) // 2
                py = y + (img_h - im.size[1]) // 2
                sheet.paste(im, (px, py))
        except Exception:
            draw.rectangle([x, y, x + cell_w - 1, y + img_h - 1], fill=(80, 20, 20))
        draw.text((x + 2, y + img_h + 4), bike["id"][:28], fill=(240, 240, 240), font=fnt)
    sheet.save(dest, "PNG", optimize=True)
    return dest


def validate(bikes: list[dict]) -> list[str]:
    errs: list[str] = []
    needed = {f["id"] for f in FLAGSHIPS}
    have = {b["id"] for b in bikes}
    for ident in sorted(needed - have):
        errs.append(f"missing flagship {ident}")
    for b in bikes:
        for key in ("id", "make", "model", "year", "cc", "category", "aliases", "thumb", "image"):
            if key not in b:
                errs.append(f"{b.get('id')} missing {key}")
        img = ROOT / b["image"]
        th = ROOT / b["thumb"]
        if not img.exists():
            errs.append(f"missing image {b['image']}")
        if not th.exists():
            errs.append(f"missing thumb {b['thumb']}")
        if b["id"] in needed and not b.get("manualId"):
            errs.append(f"{b['id']} missing manualId")
    return errs


def merge_and_write() -> tuple[list[dict], list[str]]:
    flag = ensure_flagships()
    rest = load_shards()
    # drop shard copies of flagships
    flag_ids = {f["id"] for f in FLAGSHIPS}
    rest = [r for r in rest if r["bike"]["id"] not in flag_ids]
    records = write_collection(flag + rest)
    append_credits(records)
    bikes = [r["bike"] for r in records]
    rejects = load_rejects()
    REPORT_REJECTS.parent.mkdir(parents=True, exist_ok=True)
    REPORT_REJECTS.write_text(json.dumps(rejects, indent=2), encoding="utf-8")
    return records, rejects


def make_lookup() -> dict[str, tuple[str, str, int]]:
    out = {}
    for make, cat, cap in MAKES:
        out[make.lower()] = (make, cat, cap)
        out[slug_token(make)] = (make, cat, cap)
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--make", action="append", default=[], help="Manufacturer display name (repeatable)")
    parser.add_argument("--all", action="store_true", help="Process every manufacturer")
    parser.add_argument("--limit", type=int, default=0, help="Max model categories to consider per make")
    parser.add_argument("--merge", action="store_true")
    parser.add_argument("--contact-sheet", action="store_true")
    parser.add_argument("--flagships-only", action="store_true")
    parser.add_argument("--no-merge", action="store_true")
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()

    CACHE.mkdir(parents=True, exist_ok=True)
    COLL_DIR.mkdir(parents=True, exist_ok=True)
    lookup = make_lookup()

    if args.flagships_only:
        ensure_flagships()
        records, _ = merge_and_write()
        bikes = [r["bike"] for r in records]
        build_contact_sheet(bikes, CONTACT_SHEET)
        log(f"flagships collection {len(bikes)}")
        return 0

    targets: list[tuple[str, str, int]] = []
    if args.all or (not args.make and not args.merge and not args.contact_sheet):
        targets = list(MAKES)
    for name in args.make:
        key = name.lower().strip()
        if key not in lookup:
            log(f"unknown make {name}")
            return 2
        targets.append(lookup[key])

    # de-dupe targets
    seen = set()
    uniq = []
    for t in targets:
        if t[0] not in seen:
            seen.add(t[0])
            uniq.append(t)
    targets = uniq

    limit = args.limit or None
    if targets:
        workers = max(1, min(args.workers, len(targets)))
        log(f"processing {len(targets)} makes with {workers} workers")
        if workers == 1:
            for make, cat, cap in targets:
                process_make(make, cat, cap if not limit else min(cap, limit), limit)
        else:
            with ThreadPoolExecutor(max_workers=workers) as pool:
                futs = [
                    pool.submit(process_make, make, cat, cap if not limit else min(cap, limit), limit)
                    for make, cat, cap in targets
                ]
                for fut in as_completed(futs):
                    try:
                        fut.result()
                    except Exception as e:
                        log(f"MAKE FAIL {e}")

        if not args.no_merge:
            args.merge = True
            args.contact_sheet = True

    if args.merge or args.contact_sheet:
        records, rejects = merge_and_write()
        bikes = [r["bike"] for r in records]
        errs = validate(bikes)
        if args.contact_sheet:
            path = build_contact_sheet(bikes, CONTACT_SHEET)
            log(f"contact sheet {path} ({len(bikes)} bikes)")
        log(f"collection {len(bikes)} bikes, {len(rejects)} rejects")
        if errs:
            log("VALIDATE:\n  " + "\n  ".join(errs))
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
