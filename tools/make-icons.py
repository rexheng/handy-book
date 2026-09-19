#!/usr/bin/env python3
"""Render Handy Book PWA ticket icons (192, 512, 512-maskable)."""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ORANGE = (232, 93, 4, 255)  # #e85d04
WHITE = (255, 255, 255, 255)
INK = (20, 20, 20, 255)  # #141414
TICKET = "A-17"

ROOT = Path(__file__).resolve().parent
FONT_PATH = ROOT / "fonts" / "BigShouldersDisplay-wght.ttf"
OUT_DIR = ROOT.parent / "counter" / "icons"


def extra_bold(size_px: int) -> ImageFont.FreeTypeFont:
    font = ImageFont.truetype(str(FONT_PATH), size=size_px)
    try:
        font.set_variation_by_name(b"ExtraBold")
    except (AttributeError, OSError, ValueError):
        try:
            font.set_variation_by_axes([800])
        except (AttributeError, OSError, ValueError):
            pass
    return font


def fit_font(draw: ImageDraw.ImageDraw, max_w: int, max_h: int) -> ImageFont.FreeTypeFont:
    lo, hi = 8, max(9, max_h)
    best = extra_bold(lo)
    while lo <= hi:
        mid = (lo + hi) // 2
        font = extra_bold(mid)
        left, top, right, bottom = draw.textbbox((0, 0), TICKET, font=font)
        if (right - left) <= max_w and (bottom - top) <= max_h:
            best = font
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def draw_ticket(size: int, maskable: bool) -> Image.Image:
    img = Image.new("RGBA", (size, size), ORANGE)
    draw = ImageDraw.Draw(img)

    if maskable:
        # Keep the whole ticket inside the maskable safe circle (r = 40% of size).
        r = size * 0.40
        aspect = 1.72
        half_h = r / ((aspect * aspect + 1) ** 0.5)
        half_w = aspect * half_h
        pad = size * 0.02
        left = int(round(size / 2 - half_w + pad))
        right = int(round(size / 2 + half_w - pad))
        top = int(round(size / 2 - half_h + pad))
        bottom = int(round(size / 2 + half_h - pad))
    else:
        left = int(round(size * 0.09))
        right = int(round(size * 0.91))
        top = int(round(size * 0.22))
        bottom = int(round(size * 0.78))

    border = max(2, round(size * 3 / 192))
    draw.rectangle([left, top, right, bottom], fill=WHITE, outline=INK, width=border)

    stub = int(round((right - left) * 0.18))
    perf_x = left + stub
    hole_r = max(2, int(round(size * (0.026 if maskable else 0.028))))
    dash_w = max(2, border)
    dash_h = max(4, size // 28)
    dash_gap = max(3, size // 36)
    dy = top + border + dash_h
    while dy + dash_h < bottom - border:
        draw.rectangle(
            [perf_x - dash_w // 2, dy, perf_x + dash_w // 2, dy + dash_h],
            fill=INK,
        )
        dy += dash_h + dash_gap

    gap = hole_r * 2 + max(2, size // 64)
    y = top + hole_r + border
    while y + hole_r < bottom - border:
        draw.ellipse(
            [perf_x - hole_r, y - hole_r, perf_x + hole_r, y + hole_r],
            fill=ORANGE,
        )
        y += gap

    body_left = perf_x + hole_r + max(4, size // 32)
    body_right = right - border - max(4, size // 32)
    body_top = top + border + max(4, size // 32)
    body_bottom = bottom - border - max(4, size // 32)
    font = fit_font(
        draw,
        max(8, body_right - body_left),
        max(8, body_bottom - body_top),
    )
    bbox = draw.textbbox((0, 0), TICKET, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = body_left + (body_right - body_left - tw) // 2 - bbox[0]
    ty = body_top + (body_bottom - body_top - th) // 2 - bbox[1]
    draw.text((tx, ty), TICKET, font=font, fill=INK)
    return img


def main() -> None:
    if not FONT_PATH.is_file():
        raise SystemExit(f"missing font: {FONT_PATH}")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    jobs = [
        ("icon-192.png", 192, False),
        ("icon-512.png", 512, False),
        ("icon-512-maskable.png", 512, True),
    ]
    for name, size, maskable in jobs:
        path = OUT_DIR / name
        draw_ticket(size, maskable=maskable).save(path, "PNG")
        print(path)


if __name__ == "__main__":
    main()
