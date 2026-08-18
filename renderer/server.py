#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import tempfile
import traceback
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

PORT = int(os.environ.get('PORT', '8080'))
R2 = 'http://r2.local/'
W, H, FPS = 1080, 1920, 30
ORANGE = (255, 91, 17, 255)
FALLBACK = '/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-BoldOblique.ttf'


def clamp(v, a, b):
    return max(a, min(b, v))


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode:
        raise RuntimeError('\n'.join(p.stderr.splitlines()[-40:]))
    return p.stdout


def probe(path):
    data = json.loads(run([
        'ffprobe', '-v', 'error', '-show_entries',
        'format=duration:stream=codec_type,width,height', '-of', 'json', str(path)
    ]))
    return {
        'duration': float(data.get('format', {}).get('duration') or 0),
        'has_audio': any(x.get('codec_type') == 'audio' for x in data.get('streams', [])),
    }


def r2url(key):
    return R2 + urllib.parse.quote(key, safe='/')


def download(key, path):
    with urllib.request.urlopen(r2url(key), timeout=120) as response, open(path, 'wb') as handle:
        shutil.copyfileobj(response, handle, 1024 * 1024)


def upload(key, path):
    with open(path, 'rb') as handle:
        req = urllib.request.Request(
            r2url(key), data=handle, method='PUT',
            headers={'content-type': 'video/mp4', 'content-length': str(os.path.getsize(path))}
        )
        urllib.request.urlopen(req, timeout=1200).read()


def font(workdir):
    target = Path(workdir) / 'pf-din.ttf'
    try:
        download('assets/pf-din-text-comp-pro-bold-italic.ttf', target)
        if target.stat().st_size > 1000:
            return str(target)
    except Exception:
        pass
    return FALLBACK


def rgba(value, default=(255, 255, 255, 255)):
    if not isinstance(value, str):
        return default
    text = value.strip().lstrip('#')
    try:
        if len(text) == 6:
            return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
        if len(text) == 8:
            return tuple(int(text[i:i + 2], 16) for i in (0, 2, 4, 6))
    except ValueError:
        return default
    return default


def word_color(colors, index, fallback):
    if not isinstance(colors, dict):
        return fallback
    return rgba(colors.get(str(index), colors.get(index)), fallback)


def plate_image(config, workdir, font_path):
    cfg = config or {}
    text = str(cfg.get('text') or '').strip().upper()
    if not text:
        return None

    font_size = int(clamp(float(cfg.get('fontSize') or 52), 24, 150))
    max_width = int(clamp(float(cfg.get('maxWidth') or 860), 220, 1040))
    padding_x = int(clamp(float(cfg.get('paddingX') or 24), 4, 100))
    padding_y = int(clamp(float(cfg.get('paddingY') or 12), 3, 80))
    radius = int(clamp(float(cfg.get('radius') or 18), 0, 80))
    bg = rgba(cfg.get('backgroundColor'), (17, 17, 17, 255))
    border = rgba(cfg.get('borderColor'), ORANGE)
    base_text = rgba(cfg.get('textColor'), (255, 255, 255, 255))
    border_enabled = bool(cfg.get('borderEnabled', True))
    colors = cfg.get('wordColors') or {}
    fnt = ImageFont.truetype(font_path, font_size)

    measure = Image.new('RGBA', (max_width, 2000), (0, 0, 0, 0))
    md = ImageDraw.Draw(measure)
    space_w = md.textlength(' ', font=fnt)
    content_limit = max(40, max_width - 2 * padding_x)
    line_height = int(font_size * 1.02)

    lines = []
    global_word_index = 0
    for raw_line in text.split('\n'):
        words = raw_line.split()
        if not words:
            lines.append([])
            continue
        current = []
        current_w = 0.0
        for word in words:
            ww = md.textlength(word, font=fnt)
            needed = ww if not current else space_w + ww
            if current and current_w + needed > content_limit:
                lines.append(current)
                current = []
                current_w = 0.0
                needed = ww
            current.append((word, global_word_index, ww))
            global_word_index += 1
            current_w += needed
        lines.append(current)

    line_widths = []
    for line in lines:
        width = 0.0
        for i, (_, _, ww) in enumerate(line):
            width += ww + (space_w if i else 0)
        line_widths.append(width)
    content_w = int(max(line_widths or [0]))
    image_w = min(max_width, max(40, content_w + 2 * padding_x))
    image_h = max(30, len(lines) * line_height + 2 * padding_y)

    image = Image.new('RGBA', (image_w, image_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    outline_w = 4 if border_enabled else 0
    draw.rounded_rectangle(
        (1, 1, image_w - 2, image_h - 2),
        radius=radius,
        fill=bg,
        outline=border if border_enabled else None,
        width=outline_w,
    )

    y = padding_y - int(font_size * 0.08)
    for line in lines:
        x = padding_x
        for i, (word, idx, ww) in enumerate(line):
            if i:
                x += space_w
            draw.text((x, y), word, font=fnt, fill=word_color(colors, idx, base_text))
            x += ww
        y += line_height

    path = Path(workdir) / 'plate.png'
    image.save(path)
    x = int(clamp(float(cfg.get('x', 0.08)), 0, 0.95) * W)
    y = int(clamp(float(cfg.get('y', 0.10)), 0, 0.95) * H)
    return str(path), x, y


def sponsor_image(config, workdir, font_path):
    cfg = config or {}
    sponsor_type = str(cfg.get('type') or 'none')
    if sponsor_type not in ('winline', 'difference'):
        return None

    if sponsor_type == 'winline':
        width, height, label, size = 215, 53, 'WINLINE', 34
        default_x = 740 / 1080
    else:
        width, height, label, size = 325, 49, 'ДЕЛАЕТ РАЗНИЦУ', 27
        default_x = 626 / 1080

    image = Image.new('RGBA', (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle(
        (1, 1, width - 2, height - 2),
        radius=max(18, height // 2 - 2),
        fill=(18, 18, 18, 244), outline=ORANGE, width=4,
    )
    cx, cy = width - 25, height // 2
    circle_r = 17 if sponsor_type == 'winline' else 15
    draw.ellipse((cx - circle_r, cy - circle_r, cx + circle_r, cy + circle_r), fill=ORANGE)
    fnt = ImageFont.truetype(font_path, size)
    box = draw.textbbox((0, 0), label, font=fnt)
    text_h = box[3] - box[1]
    ty = (height - text_h) / 2 - box[1] - 1
    draw.text((13, ty), label, font=fnt, fill='white')

    scale = clamp(float(cfg.get('scale') or 1), 0.5, 2.0)
    if abs(scale - 1) > 0.001:
        image = image.resize((max(1, int(width * scale)), max(1, int(height * scale))), Image.Resampling.LANCZOS)

    path = Path(workdir) / f'sponsor-{sponsor_type}.png'
    image.save(path)
    x = int(clamp(float(cfg.get('x', default_x)), 0, 0.95) * W)
    y = int(clamp(float(cfg.get('y', 336 / 1920)), 0, 0.95) * H)
    return str(path), x, y


def tf(rw, rh, transform):
    transform = transform or {}
    zoom = clamp(float(transform.get('zoom') or 1), 1, 4)
    x = clamp(float(transform.get('panX') or 0), -1, 1)
    y = clamp(float(transform.get('panY') or 0), -1, 1)
    ratio = rw / rh
    return (
        f"scale=w='if(gt(a,{ratio:.10f}),-2,ceil({rw}*{zoom:.6f}/2)*2)'"
        f":h='if(gt(a,{ratio:.10f}),ceil({rh}*{zoom:.6f}/2)*2,-2)',"
        f"crop={rw}:{rh}:'(iw-ow)/2*(1+{x:.6f})':'(ih-oh)/2*(1+{y:.6f})',"
        f"setsar=1,fps={FPS},format=yuv420p"
    )


def clip(config, actual):
    start = clamp(float(config.get('trimStart') or 0), 0, max(0, actual - 0.05))
    end = clamp(float(config.get('trimEnd') or actual), start + 0.05, actual)
    return start, end, end - start


def overlay_layers(cmd, filters, label, preset, config, workdir, font_path, index):
    aliases = {'label': 'plate', 'winline': 'sponsor'}
    preset = aliases.get(preset, preset)
    include_plate = preset in ('plate', 'combined')
    include_sponsor = preset in ('sponsor', 'combined')

    if include_plate and (config.get('plate') or {}).get('enabled', True):
        result = plate_image(config.get('plate'), workdir, font_path)
        if result:
            path, x, y = result
            cmd += ['-loop', '1', '-framerate', str(FPS), '-i', path]
            next_label = f'vplate{index}'
            filters.append(f'[{label}][{index}:v]overlay={x}:{y}:eof_action=repeat:shortest=0[{next_label}]')
            label = next_label
            index += 1

    if include_sponsor:
        result = sponsor_image(config.get('sponsor'), workdir, font_path)
        if result:
            path, x, y = result
            cmd += ['-loop', '1', '-framerate', str(FPS), '-i', path]
            next_label = f'vsponsor{index}'
            filters.append(f'[{label}][{index}:v]overlay={x}:{y}:eof_action=repeat:shortest=0[{next_label}]')
            label = next_label
            index += 1

    return label


def render_single(config, preset, a_path, a_info, out, workdir, font_path):
    a = config['videoA']
    start, _, duration = clip(a, a_info['duration'])
    cmd = ['ffmpeg', '-y', '-hide_banner', '-loglevel', 'warning', '-ss', f'{start:.6f}', '-i', str(a_path)]
    filters = [f"[0:v]trim=duration={duration:.6f},setpts=PTS-STARTPTS,{tf(W, H, a.get('single'))}[vbase]"]
    final = overlay_layers(cmd, filters, 'vbase', preset, config, workdir, font_path, 1)
    cmd += ['-filter_complex', ';'.join(filters), '-map', f'[{final}]']
    if a_info['has_audio']:
        cmd += ['-map', '0:a?', '-c:a', 'aac', '-b:a', '192k']
    else:
        cmd += ['-an']
    cmd += [
        '-t', f'{duration:.6f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', str(FPS), str(out)
    ]
    run(cmd)


def audio(filters, mode, audio_a, audio_b, split, total, rest):
    if mode == 'b' and audio_b:
        filters.append(f'[1:a]atrim=duration={total:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]')
        return 'aout'
    if mode == 'mix' and audio_a and audio_b:
        filters += [
            f'[0:a]atrim=duration={split:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aa]',
            f'[1:a]atrim=duration={split:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bb]',
            '[aa][bb]amix=inputs=2:duration=shortest:dropout_transition=0[mix0]',
        ]
        if rest > 0.02:
            filters += [
                f'[1:a]atrim=start={split:.6f}:duration={rest:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[brest]',
                '[mix0][brest]concat=n=2:v=0:a=1[aout]',
            ]
        else:
            filters.append('[mix0]anull[aout]')
        return 'aout'
    if audio_a:
        filters.append(f'[0:a]atrim=duration={split:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aa]')
        if rest > 0.02:
            filters += [
                f'anullsrc=r=48000:cl=stereo,atrim=duration={rest:.6f}[sil]',
                '[aa][sil]concat=n=2:v=0:a=1[aout]',
            ]
        else:
            filters.append('[aa]anull[aout]')
        return 'aout'
    if audio_b:
        filters.append(f'[1:a]atrim=duration={total:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]')
        return 'aout'
    return None


def render_split(config, preset, a_path, b_path, a_info, b_info, out, workdir, font_path):
    a, b = config['videoA'], config['videoB']
    a_start, _, a_duration = clip(a, a_info['duration'])
    b_start, _, b_duration = clip(b, b_info['duration'])
    split = min(a_duration, b_duration)
    rest = max(0, b_duration - split)
    cmd = [
        'ffmpeg', '-y', '-hide_banner', '-loglevel', 'warning',
        '-ss', f'{a_start:.6f}', '-i', str(a_path), '-ss', f'{b_start:.6f}', '-i', str(b_path)
    ]
    filters = [
        f"[0:v]trim=duration={split:.6f},setpts=PTS-STARTPTS,{tf(W, H // 2, a.get('split'))}[va]",
        f"[1:v]trim=duration={split:.6f},setpts=PTS-STARTPTS,{tf(W, H // 2, b.get('split'))}[vb]",
        '[va][vb]vstack=inputs=2[split]',
    ]
    if rest > 0.02:
        filters += [
            f"[1:v]trim=start={split:.6f}:duration={rest:.6f},setpts=PTS-STARTPTS,{tf(W, H, b.get('full'))}[bfull]",
            '[split][bfull]concat=n=2:v=1:a=0[vbase]',
        ]
    else:
        filters.append('[split]null[vbase]')

    audio_label = audio(filters, config.get('audioMode') or 'b', a_info['has_audio'], b_info['has_audio'], split, b_duration, rest)
    final = overlay_layers(cmd, filters, 'vbase', preset, config, workdir, font_path, 2)
    cmd += ['-filter_complex', ';'.join(filters), '-map', f'[{final}]']
    if audio_label:
        cmd += ['-map', f'[{audio_label}]', '-c:a', 'aac', '-b:a', '192k']
    else:
        cmd += ['-an']
    cmd += [
        '-t', f'{b_duration:.6f}', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '19',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', str(FPS), str(out)
    ]
    run(cmd)


def render_job(job_id, config):
    allowed = ('clean', 'plate', 'sponsor', 'combined', 'label', 'winline')
    presets = [p for p in config.get('outputs', []) if p in allowed]
    if not presets:
        presets = ['combined']
    results = []
    with tempfile.TemporaryDirectory(prefix='render-') as temp_dir:
        temp_dir = Path(temp_dir)
        a_path = temp_dir / 'a.mp4'
        download(config['videoA']['key'], a_path)
        a_info = probe(a_path)
        b_path = None
        b_info = None
        if config.get('layout') == 'split-full':
            b_path = temp_dir / 'b.mp4'
            download(config['videoB']['key'], b_path)
            b_info = probe(b_path)
        font_path = font(temp_dir)

        for preset in presets:
            normalized = {'label': 'plate', 'winline': 'sponsor'}.get(preset, preset)
            out = temp_dir / f'{normalized}.mp4'
            if b_path is None:
                render_single(config, normalized, a_path, a_info, out, temp_dir, font_path)
            else:
                render_split(config, normalized, a_path, b_path, a_info, b_info, out, temp_dir, font_path)
            key = f'renders/{job_id}/{normalized}.mp4'
            upload(key, out)
            results.append({'preset': normalized, 'key': key})
    return results


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        print(fmt % args, flush=True)

    def reply(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json; charset=utf-8')
        self.send_header('content-length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        self.reply(200, {'ok': True}) if self.path == '/health' else self.reply(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/render':
            return self.reply(404, {'error': 'not found'})
        try:
            size = int(self.headers.get('content-length') or 0)
            payload = json.loads(self.rfile.read(size) or b'{}')
            self.reply(200, {'ok': True, 'outputs': render_job(payload['jobId'], payload['config'])})
        except Exception as error:
            traceback.print_exc()
            self.reply(500, {'error': str(error)})


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', PORT), Handler).serve_forever()
