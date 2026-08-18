// Cloudflare build trigger for free MVP deployment.
/// <reference path="../worker-configuration.d.ts" />

type AppEnv = Env & { GITHUB_RENDER_TOKEN?: string };
type UploadedPart = { partNumber: number; etag: string };
type OutputFile = { preset: string; key: string };
type JobRecord = {
  jobId: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  createdAt: string;
  updatedAt: string;
  config: Record<string, unknown>;
  renderToken: string;
  outputs?: OutputFile[];
  error?: string;
};
type UploadCreateBody = { key?: string; contentType?: string };
type UploadCompleteBody = { key?: string; uploadId?: string; parts?: UploadedPart[] };
type CompleteBody = { outputs?: OutputFile[] };
type FailedBody = { error?: string };

const json = (data: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(data), {
    ...init,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(init.headers || {}),
    },
  });

const bad = (message: string, status = 400) => json({ error: message }, { status });

const safeKey = (key: string) => {
  if (!key || key.includes('..') || key.startsWith('/')) throw new Error('Invalid object key');
  return key;
};

const uploadKey = (key: string) => {
  const safe = safeKey(key);
  if (!safe.startsWith('uploads/')) throw new Error('Uploads must use uploads/ prefix');
  return safe;
};

async function putJob(env: AppEnv, job: JobRecord) {
  job.updatedAt = new Date().toISOString();
  await env.MEDIA.put(`jobs/${job.jobId}.json`, JSON.stringify(job), {
    httpMetadata: { contentType: 'application/json' },
  });
}

async function getJob(env: AppEnv, id: string) {
  const obj = await env.MEDIA.get(`jobs/${id}.json`);
  return obj ? (JSON.parse(await obj.text()) as JobRecord) : null;
}

function publicJob(job: JobRecord) {
  const { renderToken: _renderToken, ...visible } = job;
  return visible;
}

function authorized(request: Request, job: JobRecord) {
  const auth = request.headers.get('authorization') || '';
  return auth === `Bearer ${job.renderToken}`;
}

function sourceKeys(job: JobRecord) {
  const config = job.config;
  const a = config.videoA as Record<string, unknown> | undefined;
  const b = config.videoB as Record<string, unknown> | null | undefined;
  return new Set(
    [a?.key, b?.key, 'assets/pf-din-text-comp-pro-bold-italic.ttf'].filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
}

async function dispatchRender(env: AppEnv, job: JobRecord, baseUrl: string) {
  if (!env.GITHUB_RENDER_TOKEN) {
    throw new Error('GITHUB_RENDER_TOKEN is not configured in Cloudflare Worker secrets');
  }

  const response = await fetch(
    'https://api.github.com/repos/znamteam-max/ZNAMBO-mobile-video-renderer/dispatches',
    {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${env.GITHUB_RENDER_TOKEN}`,
        'content-type': 'application/json',
        'user-agent': 'ZNAMBO-mobile-video-renderer',
        'x-github-api-version': '2026-03-10',
      },
      body: JSON.stringify({
        event_type: 'render-video',
        client_payload: {
          jobId: job.jobId,
          token: job.renderToken,
          baseUrl,
        },
      }),
    },
  );

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub dispatch failed (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function handleInternal(request: Request, env: AppEnv, url: URL) {
  const match = url.pathname.match(
    /^\/api\/internal\/jobs\/([a-f0-9-]+)\/(config|done|failed|r2)(?:\/(.*))?$/i,
  );
  if (!match) return null;

  const [, jobId, action, tail = ''] = match;
  const job = await getJob(env, jobId);
  if (!job) return bad('Job not found', 404);
  if (!authorized(request, job)) return bad('Unauthorized', 401);

  if (action === 'config' && request.method === 'GET') {
    if (job.status === 'queued') {
      job.status = 'running';
      await putJob(env, job);
    }
    return json(job.config);
  }

  if (action === 'done' && request.method === 'POST') {
    const body = (await request.json()) as CompleteBody;
    const outputs = Array.isArray(body.outputs) ? body.outputs : [];
    if (!outputs.length) return bad('Missing outputs');
    for (const output of outputs) {
      if (!output?.key?.startsWith(`renders/${jobId}/`)) return bad('Invalid output key');
    }
    job.status = 'done';
    job.outputs = outputs;
    job.error = undefined;
    await putJob(env, job);
    return json({ ok: true });
  }

  if (action === 'failed' && request.method === 'POST') {
    const body = (await request.json()) as FailedBody;
    job.status = 'failed';
    job.error = String(body.error || 'GitHub Actions renderer failed').slice(0, 4000);
    await putJob(env, job);
    return json({ ok: true });
  }

  if (action === 'r2' && tail) {
    const key = safeKey(decodeURIComponent(tail));

    if (request.method === 'GET') {
      if (!sourceKeys(job).has(key)) return bad('Object is not an input for this job', 403);
      const obj = await env.MEDIA.get(key);
      if (!obj) return new Response('Not found', { status: 404 });
      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      headers.set('etag', obj.httpEtag);
      return new Response(obj.body, { headers });
    }

    if (request.method === 'PUT') {
      if (!key.startsWith(`renders/${jobId}/`)) return bad('Invalid render output key', 403);
      if (!request.body) return bad('Missing body');
      await env.MEDIA.put(key, request.body, {
        httpMetadata: {
          contentType: request.headers.get('content-type') || 'video/mp4',
        },
      });
      return new Response(null, { status: 204 });
    }
  }

  return bad('Method not allowed', 405);
}

async function api(request: Request, env: AppEnv) {
  const url = new URL(request.url);
  const path = url.pathname;

  const internal = await handleInternal(request, env, url);
  if (internal) return internal;

  if (request.method === 'GET' && path === '/api/health') {
    return json({ ok: true, renderer: 'github-actions-free-mvp' });
  }

  if (request.method === 'POST' && path === '/api/upload/create') {
    const body = (await request.json()) as UploadCreateBody;
    if (!body.key) return bad('Missing key');
    try {
      const key = uploadKey(body.key);
      const upload = await env.MEDIA.createMultipartUpload(key, {
        httpMetadata: { contentType: body.contentType || 'video/mp4' },
      });
      return json({ key: upload.key, uploadId: upload.uploadId });
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error));
    }
  }

  if (request.method === 'PUT' && path === '/api/upload/part') {
    try {
      const key = uploadKey(url.searchParams.get('key') || '');
      const uploadId = url.searchParams.get('uploadId');
      const partNumber = Number(url.searchParams.get('partNumber'));
      if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || !request.body) {
        return bad('Invalid part upload');
      }
      const part = await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, request.body);
      return json(part);
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error));
    }
  }

  if (request.method === 'POST' && path === '/api/upload/complete') {
    const body = (await request.json()) as UploadCompleteBody;
    if (!body.key || !body.uploadId || !Array.isArray(body.parts)) {
      return bad('Invalid completion request');
    }
    try {
      const key = uploadKey(body.key);
      const obj = await env.MEDIA.resumeMultipartUpload(key, body.uploadId).complete(body.parts);
      return json({ key: obj.key, etag: obj.httpEtag });
    } catch (error) {
      return bad(error instanceof Error ? error.message : String(error));
    }
  }

  if (request.method === 'POST' && path === '/api/render') {
    const config = (await request.json()) as Record<string, unknown>;
    const layout = config.layout;
    const outputs = config.outputs;
    const videoA = config.videoA as Record<string, unknown> | undefined;
    const videoB = config.videoB as Record<string, unknown> | null | undefined;

    if (layout !== 'single' && layout !== 'split-full') return bad('Unsupported layout');
    if (
      typeof videoA?.key !== 'string' ||
      !videoA.key.startsWith('uploads/') ||
      (layout === 'split-full' &&
        (typeof videoB?.key !== 'string' || !videoB.key.startsWith('uploads/'))) ||
      !Array.isArray(outputs) ||
      outputs.length === 0
    ) {
      return bad('Incomplete render configuration');
    }

    const jobId = crypto.randomUUID();
    const now = new Date().toISOString();
    const job: JobRecord = {
      jobId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      config,
      renderToken: `${crypto.randomUUID()}-${crypto.randomUUID()}`,
    };

    await putJob(env, job);
    try {
      await dispatchRender(env, job, url.origin);
    } catch (error) {
      job.status = 'failed';
      job.error = error instanceof Error ? error.message : String(error);
      await putJob(env, job);
      return bad(job.error, 502);
    }
    return json({ jobId, status: 'queued' }, { status: 202 });
  }

  const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (request.method === 'GET' && jobMatch) {
    const job = await getJob(env, jobMatch[1]);
    return job ? json(publicJob(job)) : bad('Job not found', 404);
  }

  if (request.method === 'GET' && path.startsWith('/api/files/')) {
    const key = safeKey(decodeURIComponent(path.slice('/api/files/'.length)));
    if (!key.startsWith('renders/')) return bad('Only rendered files are downloadable', 403);
    const obj = await env.MEDIA.get(key);
    if (!obj) return new Response('Not found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set(
      'content-disposition',
      `attachment; filename="${key.split('/').pop() || 'video.mp4'}"`,
    );
    return new Response(obj.body, { headers });
  }

  return bad('Not found', 404);
}

export default {
  async fetch(request: Request, env: AppEnv) {
    return new URL(request.url).pathname.startsWith('/api/')
      ? api(request, env)
      : env.ASSETS.fetch(request);
  },
};
