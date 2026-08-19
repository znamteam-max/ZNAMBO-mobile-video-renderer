#!/usr/bin/env python3
import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import brand_assets
import server
import v2_overlay


def run(cmd):
    subprocess.run(cmd, check=True)


def main():
    fallback = Path('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-BoldOblique.ttf')
    if not fallback.exists():
        raise RuntimeError(f'Missing fallback font: {fallback}')

    with tempfile.TemporaryDirectory(prefix='znambo-smoke-') as td:
        root = Path(td)
        source = root / 'source.mp4'
        run([
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30',
            '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000',
            '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k', str(source),
        ])

        uploaded = {}

        def download(key, path):
            target = Path(path)
            if key == 'uploads/smoke.mp4':
                shutil.copyfile(source, target)
                return
            if key == 'assets/pf-din-text-comp-pro-bold-italic.ttf':
                shutil.copyfile(fallback, target)
                return
            raise RuntimeError(f'Unexpected smoke download key: {key}')

        def upload(key, path):
            target = root / key.replace('/', '__')
            shutil.copyfile(path, target)
            uploaded[key] = target

        server.download = download
        server.upload = upload
        server.sponsor_image = brand_assets.sponsor_image
        v2_overlay.install()

        config = {
            'layout': 'single',
            'videoA': {
                'key': 'uploads/smoke.mp4',
                'sourceDuration': 2,
                'trimStart': 0,
                'trimEnd': 2,
                'single': {'zoom': 1, 'panX': 0, 'panY': 0},
                'split': {'zoom': 1, 'panX': 0, 'panY': 0},
            },
            'videoB': None,
            'audioMode': 'b',
            'plate': {
                'enabled': True,
                'text': 'ПЕРВАЯ СТРОКА\nВТОРАЯ СТРОКА',
                'x': 0.12,
                'y': 0.18,
                'backgroundColor': '#111111',
                'borderColor': '#ff5b11',
                'borderEnabled': True,
                'textColor': '#ffffff',
                'wordColors': {'1': '#ff5b11'},
                'fontSize': 52,
                'maxWidth': 720,
                'paddingX': 32,
                'paddingY': 18,
                'lineGap': 8,
                'align': 'center',
                'radius': 18,
            },
            'projectLogo': {
                'enabled': True,
                'mode': 'linked',
                'scale': 0.8,
                'gap': 18,
                'x': 0.03,
                'y': 0.18,
            },
            'sponsor': {
                'type': 'winline',
                'x': 740 / 1080,
                'y': 336 / 1920,
                'scale': 1,
            },
            'outputs': ['combined'],
        }

        outputs = server.render_job('smoke', config)
        assert outputs == [{'preset': 'combined', 'key': 'renders/smoke/combined.mp4'}], outputs
        rendered = uploaded.get('renders/smoke/combined.mp4')
        assert rendered and rendered.exists() and rendered.stat().st_size > 10000
        probe = subprocess.check_output([
            'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', str(rendered),
        ], text=True).strip()
        duration = float(probe)
        assert 1.5 <= duration <= 2.5, duration
        print(json.dumps({'ok': True, 'bytes': rendered.stat().st_size, 'duration': duration}))


if __name__ == '__main__':
    main()
