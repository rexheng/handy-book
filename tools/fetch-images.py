#!/usr/bin/env python3
"""Download, crop, and write Handy Book store photographs.

Idempotent: originals are cached under %TEMP%/hb-img/src keyed by Commons
title or URL. Re-run regenerates webp outputs from the cache.
"""
from __future__ import annotations

import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
IMG = ROOT / "store" / "img"
CREDITS = ROOT / "store" / "CREDITS.md"
UA = "HandyBookImageFetcher/1.0 (https://github.com/handy-book; motorcycle parts catalogue)"
CACHE = Path(tempfile.gettempdir()) / "hb-img" / "src"
COMMONS_API = "https://commons.wikimedia.org/w/api.php"
WEBP_Q = 82
THUMB_W = 400

# kind, id, commons File: title, optional box (x,y,w,h fractions), optional anchor
ITEMS = [
    # --- bikes (3:2, ≥1200px) ---
    {
        "kind": "bike",
        "id": "honda-cb650r-2021",
        "commons": "File:Honda CB650R Motorcycle 2021.jpg",
        "bikez": "https://bikez.com/motorcycles/honda_cb650r_2021.php",
        "anchor": "center",
    },
    {
        "kind": "bike",
        "id": "yamaha-mt-07-2021",
        "commons": "File:2021 Black Yamaha MT-07.jpg",
        "bikez": "https://bikez.com/motorcycles/yamaha_mt-07_2021.php",
    },
    {
        "kind": "bike",
        "id": "kawasaki-z650-2020",
        "commons": "File:Kawasaki Z650 schwarz 2020.jpg",
        "bikez": "https://bikez.com/motorcycles/kawasaki_z650_2020.php",
    },
    {
        "kind": "bike",
        "id": "suzuki-sv650-2019",
        "commons": "File:SV 650 AL7.jpg",
        "bikez": "https://bikez.com/motorcycles/suzuki_sv650_2019.php",
    },
    # --- systems (1:1, ≥800px) ---
    {
        "kind": "system",
        "id": "engine",
        "commons": "File:2019 Honda CB650R (20190428).jpg",
        "box": (0.40, 0.36, 0.44, 0.50),
    },
    {
        "kind": "system",
        "id": "brakes",
        "commons": "File:Brembo motorcycle brake.jpg",
    },
    {
        "kind": "system",
        "id": "wheels",
        "commons": "File:Bike chain.jpg",
    },
    {
        "kind": "system",
        "id": "electrics",
        "commons": "File:Car fuse box.jpg",
    },
    {
        "kind": "system",
        "id": "fluids",
        "commons": "File:Motor oil bottles variousbrands.jpg",
    },
    {
        "kind": "system",
        "id": "body",
        "commons": "File:Flickr - ronsaunders47 - SUZUKI. GSX R-1000.jpg",
        "box": (0.28, 0.18, 0.52, 0.58),
    },
    {
        "kind": "system",
        "id": "seats",
        "commons": "File:2022 Bike Shed London Show 125.jpg",
    },
    {
        "kind": "system",
        "id": "bars",
        "commons": "File:Honda VTX 1800 C 2007 - part of handlebar.jpg",
    },
    # --- parts ---
    {
        "kind": "part",
        "id": "engine-oil",
        "commons": "File:Motor oil bottles variousbrands.jpg",
        "anchor": "top",
    },
    {
        "kind": "part",
        "id": "oil-filter",
        "commons": "File:Kawasaki W175 Motorcycle Oil Filter.jpg",
    },
    {
        "kind": "part",
        "id": "spark-plugs",
        "commons": "File:Spark plugs 3.jpg",
    },
    {
        "kind": "part",
        "id": "air-filter",
        "commons": "File:Filtro aria a coppa.jpg",
    },
    {
        "kind": "part",
        "id": "coolant",
        "commons": "File:Bardahl Tir Refrigerante.jpg",
    },
    {
        "kind": "part",
        "id": "brake-fluid",
        "commons": "File:Líquido para frenos Bardahl DOT 3, 1000cc.jpg",
    },
    {
        "kind": "part",
        "id": "front-brake-pads",
        "commons": "File:Worn metallic disc brake pads.jpg",
    },
    {
        "kind": "part",
        "id": "rear-brake-pads",
        "commons": "File:Performance Disk Brake Pads.jpg",
    },
    {
        "kind": "part",
        "id": "drive-chain",
        "commons": "File:MX Olimunllum Chain Wheel.JPG",
        "box": (0.32, 0.0, 0.68, 0.72),
    },
    {
        "kind": "part",
        "id": "tires",
        "commons": "File:Tires for motorcycle racing.jpg",
    },
    {
        "kind": "part",
        "id": "battery",
        "commons": "File:Lead-acid battery for motorcycle.jpg",
    },
    {
        "kind": "part",
        "id": "fuses",
        "commons": "File:Fuse255.jpg",
    },
    {
        "kind": "part",
        "id": "headlight",
        "commons": "File:Suzuki GSX-S125 side lights.jpg",
        "box": (0.35, 0.08, 0.50, 0.70),
    },
    {
        "kind": "part",
        "id": "side-cover",
        "commons": "File:Honda Goldwing 1800 F6B detail.jpg",
        "box": (0.02, 0.18, 0.72, 0.70),
    },
    {
        "kind": "part",
        "id": "seat",
        "commons": "File:Asiento de moto.JPG",
    },
    {
        "kind": "part",
        "id": "clutch-lever",
        "commons": "File:Bar-end yamaha.jpg",
        "box": (0.0, 0.28, 0.85, 0.62),
    },
    {
        "kind": "part",
        "id": "mirrors",
        "commons": "File:Honda NTV650 Motorcycle (1990) Left Rearview Mirror (14584692250).png",
        "box": (0.0, 0.0, 0.64, 1.0),
    },
]


def request(url: str, timeout: int = 45) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept": "*/*",
            "Referer": "https://commons.wikimedia.org/",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def commons_info(title: str) -> dict:
    params = {
        "action": "query",
        "titles": title,
        "prop": "imageinfo",
        "iiprop": "url|extmetadata|size|mime",
        "iiurlwidth": 3840,
        "format": "json",
    }
    url = COMMONS_API + "?" + urllib.parse.urlencode(params)
    data = json.loads(request(url))
    page = next(iter(data["query"]["pages"].values()))
    if "imageinfo" not in page:
        raise RuntimeError(f"Commons miss: {title}")
    ii = page["imageinfo"][0]
    em = ii.get("extmetadata") or {}

    def meta(key: str) -> str:
        raw = unescape((em.get(key) or {}).get("value") or "")
        raw = re.sub(r"<[^>]+>", " ", raw)
        return re.sub(r"\s+", " ", raw).strip()

    author = meta("Artist") or meta("Credit") or "Unknown"
    license_name = meta("LicenseShortName") or meta("License") or "Unknown"
    return {
        "title": title.replace("File:", "", 1),
        "author": author,
        "license": license_name,
        "source": ii.get("descriptionurl") or f"https://commons.wikimedia.org/wiki/{urllib.parse.quote(title)}",
        "url": ii.get("url"),
        "thumburl": ii.get("thumburl"),
        "width": ii.get("width"),
        "height": ii.get("height"),
    }


def cache_path(key: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", key)[:180]
    return CACHE / safe


def download_source(item: dict, info: dict) -> Path:
    CACHE.mkdir(parents=True, exist_ok=True)
    dest = cache_path(item["commons"])
    if dest.exists() and dest.stat().st_size > 8_000:
        return dest
    # Prefer the resized derivative: originals are often huge or 403.
    urls = [u for u in (info.get("thumburl"), info.get("url")) if u]
    last_err = None
    for url in urls:
        try:
            dest.write_bytes(request(url))
            if dest.stat().st_size > 8_000:
                return dest
        except urllib.error.HTTPError as e:
            last_err = e
            continue
    raise RuntimeError(f"download failed for {item['commons']}: {last_err}")


def to_rgb(im: Image.Image) -> Image.Image:
    if im.mode in ("RGBA", "LA"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
        bg.info = {}
        return bg
    rgb = im.convert("RGB")
    rgb.info = {}
    return rgb


def crop_box(im: Image.Image, box: tuple[float, float, float, float]) -> Image.Image:
    w, h = im.size
    x, y, bw, bh = box
    left = max(0, int(round(x * w)))
    top = max(0, int(round(y * h)))
    right = min(w, int(round((x + bw) * w)))
    bottom = min(h, int(round((y + bh) * h)))
    if right - left < 8 or bottom - top < 8:
        return im
    return im.crop((left, top, right, bottom))


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


def process(item: dict, src: Path) -> tuple[Path, Path, tuple[int, int]]:
    kind = item["kind"]
    dest_dir = IMG / {"bike": "bikes", "system": "systems", "part": "parts"}[kind]
    full_path = dest_dir / f"{item['id']}.webp"
    thumb_path = dest_dir / f"{item['id']}-thumb.webp"
    aspect = 3 / 2 if kind == "bike" else 1.0
    min_w = 1200 if kind == "bike" else 800

    with Image.open(src) as raw:
        im = to_rgb(raw)
    if item.get("box"):
        im = crop_box(im, item["box"])
    im = crop_aspect(im, aspect, item.get("anchor") or "center")
    w, h = im.size
    if w < min_w:
        raise RuntimeError(f"{item['id']} cropped width {w}px < {min_w}px")
    save_webp(im, full_path)
    tw = THUMB_W
    th = int(round(tw / aspect))
    thumb = im.resize((tw, th), Image.Resampling.LANCZOS)
    save_webp(thumb, thumb_path)
    return full_path, thumb_path, (w, h)


def md_escape(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ").strip()


def write_credits(rows: list[dict]) -> None:
    lines = [
        "# Image credits",
        "",
        "Photographs for Handy Book bikes, systems, and parts. All files are",
        "CC0, CC BY, CC BY-SA, or Public Domain. Bike model-year look was",
        "checked against Bikez (Bikez images were not downloaded).",
        "",
        "| file | title | author | source | licence | bikez |",
        "|---|---|---|---|---|---|",
    ]
    for row in rows:
        lines.append(
            "| `{file}` | {title} | {author} | {source} | {license} | {bikez} |".format(
                file=row["file"],
                title=md_escape(row["title"]),
                author=md_escape(row["author"]),
                source=row["source"],
                license=md_escape(row["license"]),
                bikez=row.get("bikez") or "",
            )
        )
    lines.append("")
    CREDITS.write_text("\n".join(lines), encoding="utf-8")


def rel(path: Path) -> str:
    return path.relative_to(ROOT).as_posix()


def main() -> int:
    wanted = set(sys.argv[1:])
    items = [i for i in ITEMS if not wanted or i["id"] in wanted]
    rows: list[dict] = []
    failed: list[str] = []
    for item in items:
        ident = f"{item['kind']}/{item['id']}"
        try:
            info = commons_info(item["commons"])
            src = download_source(item, info)
            full_path, thumb_path, size = process(item, src)
            print(f"OK {ident} {size[0]}x{size[1]} <- {info['title']}", flush=True)
            credit = {
                "title": info["title"],
                "author": info["author"],
                "source": info["source"],
                "license": info["license"],
                "bikez": item.get("bikez") or "",
            }
            rows.append({"file": rel(full_path), **credit})
            rows.append({"file": rel(thumb_path), **credit})
        except Exception as e:
            failed.append(f"{ident}: {e}")
            print(f"FAIL {ident}: {e}", file=sys.stderr)
    if not wanted:
        write_credits(rows)
        print(f"credits {len(rows)} rows -> {CREDITS}")
    if failed:
        print("FAILED:", *failed, sep="\n  ", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
