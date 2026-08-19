from pathlib import Path

from PIL import Image, ImageFile

# The original sponsor PNGs came from exported reference artwork and can contain
# a truncated final PNG data block. Browsers display them, but Pillow refuses to
# decode them unless truncated-image recovery is enabled. We immediately
# re-encode the decoded image into a clean temporary PNG before FFmpeg sees it.
ImageFile.LOAD_TRUNCATED_IMAGES = True

W = 1080
H = 1920
ROOT = Path(__file__).resolve().parents[1]
ASSETS = {
    'winline': ROOT / 'public' / 'brand' / 'winline.png',
    'difference': ROOT / 'public' / 'brand' / 'difference.png',
}
DEFAULTS = {
    'winline': (740 / W, 336 / H),
    'difference': (626 / W, 336 / H),
}


def clamp(value, low, high):
    return max(low, min(high, value))


def sponsor_image(config, workdir, _font_path):
    cfg = config or {}
    sponsor_type = str(cfg.get('type') or 'none')
    source = ASSETS.get(sponsor_type)
    if not source or not source.exists():
        return None

    with Image.open(source) as opened:
        opened.load()
        image = opened.convert('RGBA')

    scale = clamp(float(cfg.get('scale') or 1), 0.5, 2.0)
    if abs(scale - 1) > 0.001:
        image = image.resize(
            (max(1, round(image.width * scale)), max(1, round(image.height * scale))),
            Image.Resampling.LANCZOS,
        )

    target = Path(workdir) / f'sponsor-{sponsor_type}.png'
    image.save(target, format='PNG', optimize=False)

    default_x, default_y = DEFAULTS[sponsor_type]
    x = int(clamp(float(cfg.get('x', default_x)), 0, 0.98) * W)
    y = int(clamp(float(cfg.get('y', default_y)), 0, 0.98) * H)
    return str(target), x, y
