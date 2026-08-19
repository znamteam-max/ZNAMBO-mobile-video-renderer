#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

import imageio_ffmpeg
import brand_assets
import server
import v2_overlay


def main():
    fallback = Path('/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-BoldOblique.ttf')
    if not fallback.exists():
        raise RuntimeError(f'Missing fallback font: {fallback}')

    with tempfile.TemporaryDirectory(prefix='znambo-smoke-') as td:
        root = Path(td)
        bin_dir = root / 'bin'
        bin_dir.mkdir()
        ffmpeg_exe = Path(imageio_ffmpeg.get_ffmpeg_exe())
        ffmpeg_link = bin_dir / 'ffmpeg'
        ffmpeg_link.symlink_to(ffmpeg_exe)
        os.environ['PATH'] = f'{bin_dir}:{os.environ.get("PATH", "")}'

        source = root / 'source.mp4'
        subprocess.run([
            'ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
            '-f', 'lavfi', '-i', 'testsrc2=size=720x1280:rate=30',
            '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', str(source),
        ], check=True)

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
        server.probe = lambda _path: {'duration': 2.0, 'has_audio': False}
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
        print(json.dumps({'ok': True, 'bytes': rendered.stat().st_size}))


if __name__ == '__main__':
    main()
