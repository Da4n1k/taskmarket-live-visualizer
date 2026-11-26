"""Prepare lightweight web plates (< 80 KB WebP) from assets-src/ and composite public/og-image.png (1200x630).

Uses ONLY the 9 Taskmarket Brand Kit colours, self-hosted Brand Kit fonts,
untouched public/assets/taskmarket-lockup.png, and the bespoke Nano Banana 3.1
sculptural backdrop plates (zero text, zero UI, zero artifacts).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets-src"
ASSETS = ROOT / "public" / "assets"
FONTS = ASSETS / "fonts"
HERO_WEBP = ASSETS / "hero-plate.webp"
OG_WEBP = ASSETS / "og-plate.webp"
OUT = ROOT / "public" / "og-image.png"

W, H = 1200, 630

GROUND = (18, 16, 14)       # #12100E
MAROON = (58, 20, 32)       # #3A1420
PANEL = (34, 30, 26)        # #221E1A
LINE = (69, 62, 55)         # #453E37
CREAM = (239, 233, 226)     # #EFE9E2
PAPER = (255, 246, 232)     # #FFF6E8
MUTED = (176, 167, 157)     # #B0A79D
MAGENTA = (231, 64, 121)    # #E74079
SALMON = (217, 160, 151)    # #D9A097


def cover_crop(img: Image.Image, tw: int, th: int) -> Image.Image:
    sw, sh = img.size
    scale = max(tw / sw, th / sh)
    nw, nh = round(sw * scale), round(sh * scale)
    resized = img.resize((nw, nh), Image.Resampling.LANCZOS)
    left = (nw - tw) // 2
    top = (nh - th) // 2
    return resized.crop((left, top, left + tw, top + th))


def prepare_web_plates() -> None:
    hero_src = SRC / "hero-plate.jpg"
    if hero_src.exists():
        im = Image.open(hero_src).convert("RGB")
        im = cover_crop(im, 1440, 810)
        im.save(HERO_WEBP, format="WEBP", quality=78, method=6)
        print(f"Prepared {HERO_WEBP} ({HERO_WEBP.stat().st_size} bytes)")

    og_src = SRC / "og-plate.jpg"
    if og_src.exists():
        im = Image.open(og_src).convert("RGB")
        im = cover_crop(im, W, H)
        im.save(OG_WEBP, format="WEBP", quality=80, method=6)
        print(f"Prepared {OG_WEBP} ({OG_WEBP.stat().st_size} bytes)")


def build_og_backdrop() -> Image.Image:
    if OG_WEBP.exists():
        base = Image.open(OG_WEBP).convert("RGBA")
        if base.size != (W, H):
            base = cover_crop(base, W, H)
    else:
        base = Image.new("RGBA", (W, H), GROUND + (255,))

    # Subtle directional obsidian scrim on left & bottom for razor-sharp typography legibility
    scrim = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    px = scrim.load()
    for y in range(H):
        by = max(0.0, (y - 340) / 290.0) ** 1.3 * 165
        for x in range(W):
            lx = max(0.0, 1.0 - x / 940.0) ** 1.35 * 215
            alpha = int(min(228, max(lx, by)))
            px[x, y] = (GROUND[0], GROUND[1], GROUND[2], alpha)
    return Image.alpha_composite(base, scrim)


def main() -> None:
    prepare_web_plates()
    img = build_og_backdrop()
    draw = ImageDraw.Draw(img)

    # Load Brand Kit fonts
    f_serif_reg = ImageFont.truetype(str(FONTS / "InstrumentSerif-Regular.ttf"), 92)
    f_serif_ita = ImageFont.truetype(str(FONTS / "InstrumentSerif-Italic.ttf"), 92)
    f_sans_sub = ImageFont.truetype(str(FONTS / "InterTight-Variable.ttf"), 24)
    f_sans_card = ImageFont.truetype(str(FONTS / "InterTight-Variable.ttf"), 16)
    f_mono_url = ImageFont.truetype(str(FONTS / "DepartureMono-Regular.otf"), 25)
    f_mono_sm = ImageFont.truetype(str(FONTS / "DepartureMono-Regular.otf"), 13)
    f_mono_val = ImageFont.truetype(str(FONTS / "DepartureMono-Regular.otf"), 19)

    # 1. Untouched lockup top-left (>= 30% width = 376px; height = 68px; clear space >= 68px)
    lockup = Image.open(ASSETS / "taskmarket-lockup.png").convert("RGBA")
    target_w = 376
    target_h = round(lockup.height * (target_w / lockup.width))
    lockup_resized = lockup.resize((target_w, target_h), Image.Resampling.LANCZOS)
    img.alpha_composite(lockup_resized, (68, 66))

    # 2. taskmarket.dev top-right in Departure Mono
    url_text = "taskmarket.dev"
    url_bbox = draw.textbbox((0, 0), url_text, font=f_mono_url)
    url_w = url_bbox[2] - url_bbox[0]
    draw.text((W - 68 - url_w, 84), url_text, font=f_mono_url, fill=CREAM)

    # 3. One Instrument Serif headline with ONE magenta italic accent word
    part1 = "Live market "
    part2 = "telemetry."
    hx, hy = 68, 200
    draw.text((hx, hy), part1, font=f_serif_reg, fill=CREAM)
    p1_w = draw.textlength(part1, font=f_serif_reg)
    draw.text((hx + p1_w, hy), part2, font=f_serif_ita, fill=MAGENTA)

    # 4. Plain Brand-Kit subtitle (zero banned words, zero invented numbers)
    draw.text(
        (68, 312),
        "Escrow flows, agent convergence, and weekly posters across Tempo (OUSD) & Base (USDC).",
        font=f_sans_sub,
        fill=MUTED,
    )

    # 5. Four calm Brand Kit translucent obsidian tiles with generous inner padding
    tiles = [
        ("CHAINS", "Tempo & Base", "OUSD 4217 · USDC 8453", SALMON),
        ("CAPITAL FLOW", "Escrow River", "Requester tiers to payout", LINE),
        ("COMPETITION", "Swarm Map", "Reward vs submissions", LINE),
        ("LIVE LEDGER", "Server-Cached", "Weekly posters & feed", LINE),
    ]
    tile_w = 248
    tile_h = 122
    tile_gap = 24
    ty = 390
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    odraw = ImageDraw.Draw(overlay)
    for idx, (kicker, title, desc, border_col) in enumerate(tiles):
        tx = 68 + idx * (tile_w + tile_gap)
        odraw.rounded_rectangle(
            [tx, ty, tx + tile_w, ty + tile_h],
            radius=12,
            fill=PANEL + (226,),
            outline=border_col + (255,),
            width=2 if idx == 0 else 1,
        )
    img = Image.alpha_composite(img, overlay)
    draw = ImageDraw.Draw(img)

    for idx, (kicker, title, desc, _) in enumerate(tiles):
        tx = 68 + idx * (tile_w + tile_gap)
        draw.text((tx + 18, ty + 18), kicker, font=f_mono_sm, fill=MUTED)
        draw.text((tx + 18, ty + 46), title, font=f_mono_val, fill=PAPER)
        draw.text((tx + 18, ty + 82), desc, font=f_sans_card, fill=MUTED)

    # 6. Bottom divider + sign-off
    draw.line([(68, 552), (W - 68, 552)], fill=LINE, width=1)
    draw.text(
        (68, 574),
        "READ-ONLY LIVE MARKET VISUALIZER · API.TASKMARKET.DEV",
        font=f_mono_sm,
        fill=MUTED,
    )
    right_note = "MADE FOR A PAID TASKMARKET BOUNTY"
    rn_w = draw.textlength(right_note, font=f_mono_sm)
    draw.text((W - 68 - rn_w, 574), right_note, font=f_mono_sm, fill=MUTED)

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OUT, format="PNG", optimize=True)
    print(f"Generated {OUT} ({W}x{H}, {OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
