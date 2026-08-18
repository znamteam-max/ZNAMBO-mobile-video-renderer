#!/usr/bin/env python3
import argparse
import json
import os
import shutil
import urllib.parse
import urllib.request
from pathlib import Path

import server


def auth_headers():
    token = os.environ.get('R2_AUTH_TOKEN', '')
    return {'authorization': f'Bearer {token}'} if token else {}


def r2url(key: str) -> str:
    base = os.environ['R2_BASE']
    if not base.endswith('/'):
        base += '/'
    return base + urllib.parse.quote(key, safe='/')


def download(key, path):
    req = urllib.request.Request(r2url(key), headers=auth_headers())
    with urllib.request.urlopen(req, timeout=600) as response, open(path, 'wb') as handle:
        shutil.copyfileobj(response, handle, 1024 * 1024)


def upload(key, path):
    headers = {
        **auth_headers(),
        'content-type': 'video/mp4',
        'content-length': str(os.path.getsize(path)),
    }
    with open(path, 'rb') as handle:
        req = urllib.request.Request(r2url(key), data=handle, method='PUT', headers=headers)
        urllib.request.urlopen(req, timeout=1200).read()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--job-id', required=True)
    parser.add_argument('--job-file', required=True)
    parser.add_argument('--result-file', required=True)
    args = parser.parse_args()

    with open(args.job_file, 'r', encoding='utf-8') as handle:
        config = json.load(handle)

    server.download = download
    server.upload = upload

    outputs = server.render_job(args.job_id, config)
    result = {'outputs': outputs}
    Path(args.result_file).write_text(json.dumps(result, ensure_ascii=False), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
