#!/usr/bin/env python3
"""Render catalog-referenced PDF pages to webp (full + thumb). Idempotent."""
from __future__ import annotations

import io
import json
import sys
from pathlib import Path

import fitz
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "store" / "catalog.json"
FULL_W = 1400
THUMB_W = 300
QUALITY = 80


def pages_to_render(manual: dict, jobs: list[dict]) -> set[int]:
    needed: set[int] = {1}
    for entry in manual.get("toc") or []:
        p = entry.get("page")
        if isinstance(p, int) and p >= 1:
            needed.add(p)
    mid = manual.get("id")
    for job in jobs:
        if job.get("manualId") != mid:
            continue
        for p in job.get("pages") or []:
            if isinstance(p, int) and p >= 1:
                needed.add(p)
        for step in job.get("steps") or []:
            p = step.get("page")
            if isinstance(p, int) and p >= 1:
                needed.add(p)
        for rel in job.get("related") or []:
            p = rel.get("page")
            if isinstance(p, int) and p >= 1:
                needed.add(p)
    return needed


def render_page(page, dest: Path, width: int) -> None:
    zoom = width / float(page.rect.width)
    mat = fitz.Matrix(zoom, zoom)
    pix = page.get_pixmap(matrix=mat, alpha=False)
    dest.parent.mkdir(parents=True, exist_ok=True)
    img = Image.open(io.BytesIO(pix.tobytes("png"))).convert("RGB")
    img.save(dest, "WEBP", quality=QUALITY, method=4)


def main() -> int:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    jobs = catalog.get("jobs") or []
    n_written = 0
    n_skipped = 0
    for manual in catalog.get("manuals") or []:
        pdf_path = ROOT / manual["file"]
        if not pdf_path.exists():
            print(f"missing pdf {pdf_path}", file=sys.stderr)
            continue
        pages_dir = ROOT / manual["pagesDir"]
        needed = sorted(pages_to_render(manual, jobs))
        doc = fitz.open(pdf_path)
        for n in needed:
            if n < 1 or n > doc.page_count:
                print(f"skip out-of-range {manual['id']} p{n}", file=sys.stderr)
                continue
            full = pages_dir / f"p-{n:04d}.webp"
            thumb = pages_dir / f"t-{n:04d}.webp"
            if full.exists() and thumb.exists():
                n_skipped += 1
                continue
            page = doc[n - 1]
            if not full.exists():
                render_page(page, full, FULL_W)
            if not thumb.exists():
                render_page(page, thumb, THUMB_W)
            n_written += 1
            print(f"rendered {manual['id']} p{n:04d}")
        doc.close()
    print(f"done written={n_written} skipped={n_skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
