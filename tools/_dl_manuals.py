"""Temporary downloader for official owner's-manual PDFs. Not part of the R2 deliverable."""
from __future__ import annotations

import sys
from pathlib import Path

from playwright.sync_api import TimeoutError as PwTimeout
from playwright.sync_api import sync_playwright

ROOT = Path(r"C:\Users\Rex\Projects\handy-book")
UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36"
)


def save_pdf(path: Path, data: bytes, label: str) -> bool:
    if not data or not data.startswith(b"%PDF"):
        print(f"{label}: NOT A PDF ({len(data)} bytes, start={data[:20]!r})")
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    print(f"{label}: saved {len(data)} bytes -> {path}")
    return True


def try_request(page, url: str, referer: str | None = None) -> bytes:
    headers = {"Accept": "application/pdf,*/*"}
    if referer:
        headers["Referer"] = referer
    resp = page.request.get(url, headers=headers, timeout=120_000)
    print(f"  request {resp.status} {resp.headers.get('content-type')} {url}")
    try:
        return resp.body()
    except Exception as exc:
        print(f"  body fail: {exc}")
        return b""


def try_goto_pdf(page, url: str) -> bytes:
    try:
        resp = page.goto(url, wait_until="domcontentloaded", timeout=90_000)
    except PwTimeout:
        print(f"  goto timeout {url}")
        return b""
    if resp is None:
        print(f"  goto no response {url} title={page.title()!r}")
        return b""
    print(f"  goto {resp.status} {resp.headers.get('content-type')} {url}")
    try:
        body = resp.body()
    except Exception as exc:
        print(f"  goto body fail: {exc}")
        return b""
    return body or b""


def download_via_expect(page, clickable, dest: Path, label: str) -> bool:
    try:
        with page.expect_download(timeout=90_000) as dl_info:
            clickable.click()
        download = dl_info.value
        download.save_as(str(dest))
        data = dest.read_bytes()
        return save_pdf(dest, data, label)
    except Exception as exc:
        print(f"{label}: download click failed: {exc}")
        return False


def main() -> int:
    honda = ROOT / "store/manuals/honda-cb650r-2021-om/manual.pdf"
    yamaha = ROOT / "store/manuals/yamaha-mt-07-2021-om/manual.pdf"
    kawa = ROOT / "store/manuals/kawasaki-z650-2020-om/manual.pdf"

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            accept_downloads=True,
            user_agent=UA,
            locale="en-US",
            extra_http_headers={"Accept-Language": "en-US,en;q=0.9"},
        )
        page = context.new_page()

        # --- Honda US powersports CDN ---
        honda_url = "https://cdn.powersports.honda.com/documentum/MWOM/ml.remawmom.2021_31mkyg0_cb650r.pdf"
        print("=== HONDA CDN ===")
        page.goto("https://powersports.honda.com/downloads/owners-manuals", timeout=60_000)
        print("  landed", page.url, page.title())
        data = try_request(page, honda_url, referer="https://powersports.honda.com/downloads/owners-manuals")
        if not save_pdf(honda, data, "honda-cdn-request"):
            data = try_goto_pdf(page, honda_url)
            save_pdf(honda, data, "honda-cdn-goto")

        if not honda.exists() or honda.stat().st_size < 1000:
            print("=== HONDA MOTOPUB ===")
            page.goto("https://www.hondamotopub.com/om/HMEE/CB650R/2021", timeout=60_000)
            page.wait_for_timeout(2000)
            print("  motopub", page.url, page.title())
            # Accept license if present
            for sel in [
                'button:has-text("Agree")',
                'button:has-text("I agree")',
                'input[type="submit"]',
                'a:has-text("Agree")',
                'button:has-text("Accept")',
                'input[value*="Agree"]',
                "#agree",
                ".agree",
            ]:
                loc = page.locator(sel)
                if loc.count():
                    print(f"  clicking {sel} count={loc.count()}")
                    try:
                        loc.first.click(timeout=5000)
                        page.wait_for_timeout(2500)
                    except Exception as exc:
                        print(f"  click fail {exc}")
            # dump candidate links
            hrefs = page.eval_on_selector_all(
                "a[href]", "els => els.map(e => e.href)"
            )
            pdf_hrefs = [h for h in hrefs if h and (".pdf" in h.lower() or "pdf" in h.lower())]
            print("  hrefs", len(hrefs), "pdf-ish", pdf_hrefs[:20])
            print("  html snippet", page.content()[:1500])
            for h in pdf_hrefs:
                data = try_request(page, h, referer=page.url)
                if save_pdf(honda, data, f"honda-motopub {h}"):
                    break
            # HTML viewer often embeds iframe
            frames = [f.url for f in page.frames]
            print("  frames", frames)

        # --- Yamaha EU CDN ---
        print("=== YAMAHA EU CDN ===")
        page.goto("https://www.yamaha-motor.eu/gb/en/service-support/owner-manuals/", timeout=60_000)
        print("  landed", page.url)
        y_url = "https://cdn.yamaha-motor.eu/owner-manuals/Motorcycles/P1WS28199E2E.PDF"
        data = try_request(page, y_url, referer="https://www.yamaha-motor.eu/gb/en/service-support/owner-manuals/")
        if not save_pdf(yamaha, data, "yamaha-eu-request"):
            data = try_goto_pdf(page, y_url)
            save_pdf(yamaha, data, "yamaha-eu-goto")

        if not yamaha.exists() or yamaha.stat().st_size < 1000:
            print("=== YAMAHA US FORM ===")
            page.goto("https://yamaha-owners-manuals.com/", timeout=60_000)
            page.wait_for_timeout(2000)
            print("  yamaha us", page.url, page.content()[:800])
            # Try select motorcycle / 2021 / MT-07
            for attempt in range(1):
                try:
                    page.select_option("select", label="Motorcycle", timeout=5000)
                except Exception:
                    pass
            # dump selects
            print(
                page.eval_on_selector_all(
                    "select, input, button",
                    """els => els.map(e => ({
                        tag: e.tagName, id: e.id, name: e.name, type: e.type,
                        text: (e.innerText||'').slice(0,80),
                        options: e.tagName==='SELECT' ? [...e.options].slice(0,30).map(o=>o.text) : []
                    }))""",
                )
            )

        # --- Kawasaki KTIVS ---
        print("=== KAWASAKI KTIVS ===")
        page.goto("https://pws.ktivs.net/manuals", timeout=60_000)
        page.wait_for_timeout(3000)
        print("  kawa", page.url, page.title())
        print("  kawa html", page.content()[:2000])

        browser.close()

    print("DONE exists honda", honda.exists(), honda.stat().st_size if honda.exists() else 0)
    print("DONE exists yamaha", yamaha.exists(), yamaha.stat().st_size if yamaha.exists() else 0)
    print("DONE exists kawa", kawa.exists(), kawa.stat().st_size if kawa.exists() else 0)
    return 0


if __name__ == "__main__":
    sys.exit(main())
