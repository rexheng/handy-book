#!/usr/bin/env python3
"""Extract PyMuPDF text for every rendered manual page. Idempotent."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import fitz

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / "store" / "catalog.json"
WS = re.compile(r"[ \t]+")
NL = re.compile(r"\n{3,}")


def normalize(text: str) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = WS.sub(" ", text)
    text = NL.sub("\n\n", text)
    return text.strip() + ("\n" if text.strip() else "")


def rendered_pages(pages_dir: Path) -> list[int]:
    nums: list[int] = []
    for p in pages_dir.glob("p-*.webp"):
        m = re.fullmatch(r"p-(\d{4})\.webp", p.name)
        if m:
            nums.append(int(m.group(1)))
    return sorted(set(nums))


def main() -> int:
    catalog = json.loads(CATALOG.read_text(encoding="utf-8-sig"))
    n_written = 0
    n_empty = 0
    n_skipped = 0
    for manual in catalog.get("manuals") or []:
        pdf_path = ROOT / manual["file"]
        pages_dir = ROOT / manual["pagesDir"]
        text_dir = ROOT / (manual.get("textDir") or str(Path(manual["pagesDir"]).parent / "text"))
        if not pdf_path.exists():
            print(f"missing pdf {pdf_path}", file=sys.stderr)
            continue
        needed = rendered_pages(pages_dir)
        if not needed:
            print(f"no rendered pages {manual['id']}", file=sys.stderr)
            continue
        text_dir.mkdir(parents=True, exist_ok=True)
        ocr = manual.get("ocr", True)
        doc = fitz.open(pdf_path)
        for n in needed:
            dest = text_dir / f"p-{n:04d}.txt"
            if n < 1 or n > doc.page_count:
                print(f"skip out-of-range {manual['id']} p{n}", file=sys.stderr)
                continue
            if dest.exists() and dest.stat().st_size >= 0 and "--force" not in sys.argv:
                # Always rewrite so empty image-only files stay in sync.
                pass
            if not ocr:
                if dest.exists() and dest.stat().st_size == 0:
                    n_skipped += 1
                    continue
                dest.write_text("", encoding="utf-8")
                n_empty += 1
                print(f"empty {manual['id']} p{n:04d}")
                continue
            page = doc[n - 1]
            text = normalize(page.get_text("text") or "")
            dest.write_text(text, encoding="utf-8")
            if text:
                n_written += 1
            else:
                n_empty += 1
            print(f"text {manual['id']} p{n:04d} chars={len(text)}")
        doc.close()
    print(f"done written={n_written} empty={n_empty} skipped={n_skipped}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
