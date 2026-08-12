#!/usr/bin/env python3
"""Regenerate the Play Store listing graphics for the new purple-cat mark.

The listing icon and feature graphic are uploaded separately from the APK, so
neither of them changed when the new icon shipped inside the binary. This
rebuilds both, keeping the feature graphic's existing composition (badge left,
wordmark and tagline right, dark ground) so only the artwork changes.
"""
import pathlib
from PIL import Image, ImageDraw, ImageFont

ROOT = pathlib.Path("/Users/dirghaprasad/.superset/worktrees/d0f7efc8-f57a-4cfa-815d-31bfe16b12a4/discord")
OUT = pathlib.Path("/private/tmp/claude-501/-Users-dirghaprasad--superset-worktrees-d0f7efc8-f57a-4cfa-815d-31bfe16b12a4-discord/529fd53f-4ee6-4a43-9d0b-4a496588f046/scratchpad")

# The transparent-corner master; the full-bleed one is the web icon.
MARK = Image.open(ROOT / "apps/web/src/assets/icon.png").convert("RGBA")
FULL = Image.open(ROOT / "apps/web/public/assets/icon.png").convert("RGB")

# ── listing icon: 512 square, full bleed. Play applies its own mask. ────────
FULL.resize((512, 512), Image.LANCZOS).save(OUT / "play-icon-new.png")

# ── feature graphic: 1024x500, matching the existing layout ────────────────
W, H = 1024, 500
fg = Image.new("RGB", (W, H), (11, 11, 15))

# Soft violet glow toward the upper right. Painted at 1/16 scale and scaled up
# so the falloff is genuinely smooth — drawing concentric ellipses at full size
# leaves visible banding and a hard outer edge.
sw, sh = W // 16, H // 16
small = Image.new("RGB", (sw, sh))
sp = small.load()
cx, cy, rad = sw * 0.78, sh * 0.10, sw * 0.62
for y in range(sh):
    for x in range(sw):
        t = max(0.0, 1.0 - (((x - cx) ** 2 + (y - cy) ** 2) ** 0.5) / rad) ** 2
        sp[x, y] = (int(11 + t * 30), int(11 + t * 24), int(15 + t * 52))
fg = small.resize((W, H), Image.BICUBIC)

badge = MARK.resize((220, 220), Image.LANCZOS)
fg.paste(badge, (154, 140), badge)

AVENIR = "/System/Library/Fonts/Supplemental/Avenir Next.ttc"
# Face indexes inside the .ttc, confirmed by reading getname() off each one —
# 1 is Bold *Italic*, which is what an unchecked guess lands on.
FACE = {"Bold": 0, "Demi": 2, "Regular": 7}


def font(size, weight="Bold"):
    return ImageFont.truetype(AVENIR, size, index=FACE[weight])

d = ImageDraw.Draw(fg)
d.text((437, 250), "Pounce", font=font(86), fill=(255, 255, 255), anchor="ls")
d.text((437, 316), "Watch & steer your AI agents", font=font(31, "Demi"),
       fill=(197, 194, 226), anchor="ls")

fg.save(OUT / "play-feature-new.png")
print("icon   ", (OUT / "play-icon-new.png").stat().st_size, "bytes")
print("feature", (OUT / "play-feature-new.png").stat().st_size, "bytes")
