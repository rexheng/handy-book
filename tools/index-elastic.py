#!/usr/bin/env python3
"""Index Handy Book catalog + manual page text into Elasticsearch.

Idempotent: explicit mappings, then POST /_bulk with stable _id values.
Reads ELASTIC_URL and ELASTIC_API_KEY from the environment. Never prints the key.

  python tools/index-elastic.py --dry-run   # build docs from catalog.json, no network
  python tools/index-elastic.py             # PUT mappings + _bulk
  python tools/index-elastic.py --reset     # delete+recreate indexes, then bulk
"""
from __future__ import annotations

import json
import os
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG_PATH = ROOT / "store" / "catalog.json"

INDEX_BIKES = "hb-bikes"
INDEX_PARTS = "hb-parts"
INDEX_SYSTEMS = "hb-systems"
INDEX_JOBS = "hb-jobs"
INDEX_PAGES = "hb-pages"
INDEX_NAMES = (INDEX_BIKES, INDEX_PARTS, INDEX_SYSTEMS, INDEX_JOBS, INDEX_PAGES)

TEXT_KW = {
    "type": "text",
    "fields": {"keyword": {"type": "keyword", "ignore_above": 256}},
}
KW = {"type": "keyword"}
KW_STORE = {"type": "keyword", "doc_values": False}
MONEY = {"type": "scaled_float", "scaling_factor": 100}
DATE_DAY = {"type": "date", "format": "yyyy-MM-dd||strict_date_optional_time||epoch_millis"}

# Commerce provenance objects (DATA-CONTRACT "Commerce provenance"): retrieve + filter
# by retailer / retrieved date; urls are display-only.
PROVENANCE_LISTING = {
    "from": KW,
    "url": KW_STORE,
    "price": MONEY,
    "currency": KW,
    "retrieved": DATE_DAY,
}

MAPPINGS = {
    INDEX_BIKES: {
        "dynamic": "strict",
        "properties": {
            "id": KW,
            "make": TEXT_KW,
            "model": TEXT_KW,
            "year": {"type": "integer"},
            "cc": {"type": "integer"},
            "aliases": {"type": "search_as_you_type", "max_shingle_size": 3},
            "image": KW_STORE,
            "thumb": KW_STORE,
            "manualId": KW,
            "bikez": KW_STORE,
            "seq": {"type": "integer"},
            "manual": {
                "type": "object",
                "properties": {
                    "id": KW,
                    "bikeId": KW,
                    "title": TEXT_KW,
                    "kind": KW,
                    "publisher": TEXT_KW,
                    "file": KW_STORE,
                    "pages": {"type": "integer"},
                    "pagesDir": KW_STORE,
                    "source": KW_STORE,
                    "pubCode": KW,
                    "toc": {
                        "type": "nested",
                        "properties": {
                            "title": TEXT_KW,
                            "page": {"type": "integer"},
                        },
                    },
                },
            },
        },
    },
    INDEX_PARTS: {
        "dynamic": "strict",
        "properties": {
            "id": KW,
            "systemId": KW,
            "name": TEXT_KW,
            "image": KW_STORE,
            "thumb": KW_STORE,
            "seq": {"type": "integer"},
        },
    },
    INDEX_SYSTEMS: {
        "dynamic": "strict",
        "properties": {
            "id": KW,
            "name": TEXT_KW,
            "image": KW_STORE,
            "thumb": KW_STORE,
            "seq": {"type": "integer"},
        },
    },
    INDEX_JOBS: {
        "dynamic": "strict",
        "properties": {
            "id": KW,
            "bikeId": KW,
            "partId": KW,
            "manualId": KW,
            "oem": KW,
            "oemVerified": {"type": "boolean"},
            "title": TEXT_KW,
            # Multi-value integer: every job document sends `pages` as an array of
            # 1-based PDF indices. Elasticsearch integer fields accept multiple
            # values; this is intentional (not a scalar). Do not "fix" to a single int.
            "pages": {"type": "integer"},
            "printedPage": KW,
            "steps": {
                "type": "nested",
                "properties": {
                    "page": {"type": "integer"},
                    # crop is a 4-float array [x, y, w, h] (fractions 0–1 of the page).
                    # Mapped as float; ES keeps the 4 values in `_source`. Not queried as a box.
                    "crop": {"type": "float"},
                },
            },
            "related": {
                "type": "nested",
                "properties": {
                    "page": {"type": "integer"},
                    "title": TEXT_KW,
                },
            },
            "price": MONEY,
            "ship": MONEY,
            "days": {"type": "integer"},
            "from": KW,
            "new": {
                "type": "object",
                "properties": {
                    **PROVENANCE_LISTING,
                    "ship": MONEY,
                    "days": {"type": "integer"},
                    "oem": KW,
                    "oemVerified": {"type": "boolean"},
                },
            },
            "used": {
                "type": "nested",
                "properties": {
                    **PROVENANCE_LISTING,
                    "note": {"type": "text"},
                    "where": KW,
                },
            },
            "alts": {
                "type": "nested",
                "properties": {
                    "label": TEXT_KW,
                    **PROVENANCE_LISTING,
                },
            },
            "bikeMake": TEXT_KW,
            "bikeModel": TEXT_KW,
            "bikeYear": {"type": "integer"},
            "partName": TEXT_KW,
            "systemId": KW,
        },
    },
    INDEX_PAGES: {
        "dynamic": "strict",
        "properties": {
            "id": KW,
            "manualId": KW,
            "page": {"type": "integer"},
            # Copied from job.printedPage (offset across job.pages when numeric).
            # Null when no job covers this PDF page. Never the PDF index itself.
            "printedPage": KW,
            "text": {"type": "text"},
            "ocr": {"type": "boolean"},
        },
    },
}

SSL_CTX = ssl.create_default_context()
BULK_BYTES = 2_000_000


def die(msg: str, code: int = 1) -> None:
    print(msg, file=sys.stderr)
    raise SystemExit(code)


def env_creds() -> tuple[str, str]:
    url = (os.environ.get("ELASTIC_URL") or "").strip().rstrip("/")
    key = (os.environ.get("ELASTIC_API_KEY") or "").strip()
    if not url:
        die("ELASTIC_URL is not set")
    if not key:
        die("ELASTIC_API_KEY is not set")
    return url, key


def es_call(
    base: str,
    key: str,
    method: str,
    path: str,
    body: bytes | dict | None = None,
    content_type: str = "application/json",
) -> tuple[int, object]:
    url = f"{base}{path}"
    data: bytes | None = None
    headers = {
        "Authorization": f"ApiKey {key}",
        "Accept": "application/json",
    }
    if body is not None:
        data = body if isinstance(body, (bytes, bytearray)) else json.dumps(body).encode("utf-8")
        headers["Content-Type"] = content_type
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=120, context=SSL_CTX) as resp:
            raw = resp.read()
            parsed: object = json.loads(raw) if raw else {}
            return resp.status, parsed
    except urllib.error.HTTPError as exc:
        raw = exc.read()
        parsed: object
        try:
            parsed = json.loads(raw) if raw else {"error": exc.reason}
        except json.JSONDecodeError:
            parsed = {"error": exc.reason, "status": exc.code}
        return exc.code, parsed
    except urllib.error.URLError as exc:
        die(f"Elasticsearch unreachable: {exc.reason}")


def ensure_indexes(base: str, key: str, reset: bool) -> None:
    for name, mapping in MAPPINGS.items():
        status, _ = es_call(base, key, "HEAD", f"/{name}")
        if reset and status == 200:
            dstatus, dbody = es_call(base, key, "DELETE", f"/{name}")
            if dstatus not in (200, 404):
                die(f"DELETE /{name} failed ({dstatus}): {dbody}")
            status = 404
        if status == 404:
            put, body = es_call(
                base,
                key,
                "PUT",
                f"/{name}",
                {"mappings": mapping},
            )
            if put not in (200, 201):
                die(f"PUT /{name} failed ({put}): {body}")
            print(f"created {name}")
        elif status == 200:
            print(f"exists  {name}")
        else:
            die(f"HEAD /{name} failed ({status})")


def bulk_index(base: str, key: str, rows: list[tuple[str, str, dict]]) -> int:
    if not rows:
        return 0
    ok = 0
    buf = bytearray()
    pending = 0

    def flush() -> None:
        nonlocal buf, pending, ok
        if not buf:
            return
        if buf[-1:] != b"\n":
            buf.extend(b"\n")
        status, body = es_call(
            base,
            key,
            "POST",
            "/_bulk",
            bytes(buf),
            "application/x-ndjson",
        )
        if status not in (200, 201) or not isinstance(body, dict):
            die(f"_bulk failed ({status}): {body}")
        if body.get("errors"):
            for item in body.get("items") or []:
                result = next(iter(item.values()), {})
                err = result.get("error")
                if err:
                    die(f"_bulk item error: {err.get('type')} {err.get('reason')}")
        ok += pending
        buf = bytearray()
        pending = 0

    for index, _id, doc in rows:
        action = json.dumps({"index": {"_index": index, "_id": _id}}, separators=(",", ":"))
        source = json.dumps(doc, separators=(",", ":"), ensure_ascii=False)
        piece = f"{action}\n{source}\n".encode("utf-8")
        if pending and len(buf) + len(piece) > BULK_BYTES:
            flush()
        buf.extend(piece)
        pending += 1
    flush()
    return ok


def page_id(manual_id: str, page: int) -> str:
    return f"{manual_id}__{page}"


def job_es_id(job: dict) -> str:
    """Elasticsearch `_id` uses `__`, never `/` (GET _doc + proxies that decode %2F)."""
    bike = job.get("bikeId") or ""
    part = job.get("partId") or ""
    if bike and part:
        return f"{bike}__{part}"
    return str(job.get("id") or "").replace("/", "__")


def crop_array(raw: object) -> list[float] | None:
    """Preserve a 4-float crop box [x, y, w, h]; drop anything else."""
    if not isinstance(raw, (list, tuple)) or len(raw) != 4:
        return None
    try:
        return [float(x) for x in raw]
    except (TypeError, ValueError):
        return None


def provenance_new(raw: object) -> dict | None:
    if raw is None:
        return None
    if not isinstance(raw, dict):
        return None
    return {
        "from": raw.get("from"),
        "url": raw.get("url"),
        "price": raw.get("price"),
        "currency": raw.get("currency"),
        "ship": raw.get("ship"),
        "days": raw.get("days"),
        "retrieved": raw.get("retrieved"),
        "oem": raw.get("oem"),
        "oemVerified": raw.get("oemVerified"),
    }


def provenance_used(rows: object) -> list[dict]:
    out: list[dict] = []
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        out.append(
            {
                "from": row.get("from"),
                "url": row.get("url"),
                "price": row.get("price"),
                "currency": row.get("currency"),
                "note": row.get("note"),
                "where": row.get("where"),
                "retrieved": row.get("retrieved"),
            }
        )
    return out


def provenance_alts(rows: object) -> list[dict]:
    """Carry object alts through; coerce legacy string alts to {label}."""
    out: list[dict] = []
    for row in rows or []:
        if isinstance(row, str):
            out.append({"label": row})
            continue
        if not isinstance(row, dict):
            continue
        out.append(
            {
                "label": row.get("label"),
                "from": row.get("from"),
                "url": row.get("url"),
                "price": row.get("price"),
                "currency": row.get("currency"),
                "retrieved": row.get("retrieved"),
            }
        )
    return out


def printed_page_lookup(jobs: list) -> dict[tuple[str, int], str]:
    """Map (manualId, pdfIndex) → printed stamp from job data. Missing → not in map."""
    found: dict[tuple[str, int], str] = {}
    for job in jobs:
        manual_id = job.get("manualId")
        pages = [p for p in (job.get("pages") or []) if p is not None]
        stamp = job.get("printedPage")
        if not manual_id or not pages or stamp is None or stamp == "":
            continue
        stamp_s = str(stamp)
        try:
            first = int(pages[0])
            base = int(stamp_s)
        except (TypeError, ValueError):
            try:
                found[(str(manual_id), int(pages[0]))] = stamp_s
            except (TypeError, ValueError):
                pass
            continue
        for p in pages:
            try:
                pdf_i = int(p)
            except (TypeError, ValueError):
                continue
            found[(str(manual_id), pdf_i)] = str(base + (pdf_i - first))
    return found


def extract_pages(manual: dict, printed_lookup: dict[tuple[str, int], str]) -> list[dict]:
    manual_id = manual["id"]
    file_rel = manual.get("file") or f"store/manuals/{manual_id}/manual.pdf"
    pdf_path = ROOT / file_rel
    expected = int(manual.get("pages") or 0)
    docs: list[dict] = []

    def page_doc(pdf_index: int, text: str) -> dict:
        return {
            "id": page_id(manual_id, pdf_index),
            "manualId": manual_id,
            "page": pdf_index,
            "printedPage": printed_lookup.get((manual_id, pdf_index)),
            "text": text,
            "ocr": False,
        }

    if pdf_path.is_file():
        try:
            import fitz
        except ImportError:
            print(f"PyMuPDF missing; empty text for {manual_id}", file=sys.stderr)
            fitz = None  # type: ignore
        if fitz is not None:
            with fitz.open(pdf_path) as pdf:
                for i, page in enumerate(pdf, start=1):
                    text = (page.get_text("text") or "").strip()
                    docs.append(page_doc(i, text))
            return docs

    print(f"PDF missing: {file_rel} — indexing {expected or 0} empty pages", file=sys.stderr)
    for i in range(1, max(expected, 0) + 1):
        docs.append(page_doc(i, ""))
    return docs


def build_docs(catalog: dict) -> list[tuple[str, str, dict]]:
    bikes = catalog.get("bikes") or []
    manuals = {m["id"]: m for m in catalog.get("manuals") or [] if m.get("id")}
    systems = catalog.get("systems") or []
    parts = catalog.get("parts") or []
    jobs = catalog.get("jobs") or []
    part_by_id = {p["id"]: p for p in parts if p.get("id")}
    bike_by_id = {b["id"]: b for b in bikes if b.get("id")}
    printed_lookup = printed_page_lookup(jobs)

    rows: list[tuple[str, str, dict]] = []

    for seq, bike in enumerate(bikes):
        bid = bike["id"]
        manual = manuals.get(bike.get("manualId") or "")
        doc = {
            "id": bid,
            "make": bike.get("make"),
            "model": bike.get("model"),
            "year": bike.get("year"),
            "cc": bike.get("cc"),
            "aliases": bike.get("aliases") or [],
            "image": bike.get("image"),
            "thumb": bike.get("thumb"),
            "manualId": bike.get("manualId"),
            "bikez": bike.get("bikez"),
            "seq": seq,
        }
        if manual:
            toc = []
            for entry in manual.get("toc") or []:
                toc.append({"title": entry.get("title"), "page": entry.get("page")})
            doc["manual"] = {
                "id": manual.get("id"),
                "bikeId": manual.get("bikeId"),
                "title": manual.get("title"),
                "kind": manual.get("kind"),
                "publisher": manual.get("publisher"),
                "file": manual.get("file"),
                "pages": manual.get("pages"),
                "pagesDir": manual.get("pagesDir"),
                "source": manual.get("source"),
                "pubCode": manual.get("pubCode"),
                "toc": toc,
            }
        rows.append((INDEX_BIKES, bid, doc))

    for seq, part in enumerate(parts):
        pid = part["id"]
        rows.append(
            (
                INDEX_PARTS,
                pid,
                {
                    "id": pid,
                    "systemId": part.get("systemId"),
                    "name": part.get("name"),
                    "image": part.get("image"),
                    "thumb": part.get("thumb"),
                    "seq": seq,
                },
            )
        )

    for seq, system in enumerate(systems):
        sid = system["id"]
        rows.append(
            (
                INDEX_SYSTEMS,
                sid,
                {
                    "id": sid,
                    "name": system.get("name"),
                    "image": system.get("image"),
                    "thumb": system.get("thumb"),
                    "seq": seq,
                },
            )
        )

    for job in jobs:
        jid = job["id"]
        es_id = job_es_id(job)
        bike = bike_by_id.get(job.get("bikeId") or "")
        part = part_by_id.get(job.get("partId") or "")
        steps = []
        for step in job.get("steps") or []:
            item = {"page": step.get("page")}
            crop = crop_array(step.get("crop"))
            if crop is not None:
                item["crop"] = crop
            steps.append(item)
        related = []
        for rel in job.get("related") or []:
            related.append({"page": rel.get("page"), "title": rel.get("title")})
        doc = {
            "id": jid,
            "bikeId": job.get("bikeId"),
            "partId": job.get("partId"),
            "manualId": job.get("manualId"),
            "oem": job.get("oem"),
            "oemVerified": bool(job.get("oemVerified", False)),
            "title": job.get("title"),
            "pages": job.get("pages") or [],
            "printedPage": None if job.get("printedPage") is None else str(job.get("printedPage")),
            "steps": steps,
            "related": related,
            "price": job.get("price"),
            "ship": job.get("ship"),
            "days": job.get("days"),
            "from": job.get("from"),
            "new": provenance_new(job.get("new")),
            "used": provenance_used(job.get("used")),
            "alts": provenance_alts(job.get("alts")),
            "bikeMake": None if not bike else bike.get("make"),
            "bikeModel": None if not bike else bike.get("model"),
            "bikeYear": None if not bike else bike.get("year"),
            "partName": None if not part else part.get("name"),
            "systemId": None if not part else part.get("systemId"),
        }
        rows.append((INDEX_JOBS, es_id, doc))

    for manual in catalog.get("manuals") or []:
        for page in extract_pages(manual, printed_lookup):
            rows.append((INDEX_PAGES, page["id"], page))

    return rows


def count_index(base: str, key: str, name: str) -> int:
    status, body = es_call(base, key, "GET", f"/{name}/_count")
    if status != 200 or not isinstance(body, dict):
        die(f"count {name} failed ({status}): {body}")
    return int(body.get("count") or 0)


def summarize_rows(rows: list[tuple[str, str, dict]]) -> dict[str, int]:
    counts: dict[str, int] = {name: 0 for name in INDEX_NAMES}
    seen: set[tuple[str, str]] = set()
    dup = 0
    for index, _id, _doc in rows:
        counts[index] = counts.get(index, 0) + 1
        key = (index, _id)
        if key in seen:
            dup += 1
        seen.add(key)
        if "/" in _id:
            die(f"slash in _id {index}/{_id} — use __")
    print(f"docs {len(rows)}")
    for name in INDEX_NAMES:
        print(f"count {name} {counts.get(name, 0)}")
    if dup:
        die(f"duplicate _id count {dup}")
    return counts


def main(argv: list[str]) -> int:
    reset = "--reset" in argv
    dry_run = "--dry-run" in argv
    if not CATALOG_PATH.is_file():
        die(f"catalog not found: {CATALOG_PATH}")
    catalog = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    rows = build_docs(catalog)
    summarize_rows(rows)
    if dry_run:
        return 0
    base, key = env_creds()
    print(f"cluster {base}")
    status, info = es_call(base, key, "GET", "/")
    if status != 200:
        die(f"GET / failed ({status}): {info}")
    ensure_indexes(base, key, reset=reset)
    written = bulk_index(base, key, rows)
    print(f"bulk wrote {written} docs")
    for name in INDEX_NAMES:
        print(f"count {name} {count_index(base, key, name)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
