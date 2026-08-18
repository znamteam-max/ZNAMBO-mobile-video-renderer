import { Container } from '@cloudflare/containers';

type RenderMessage = { jobId: string; config: Record<string, unknown> };
type Env = { ASSETS: Fetcher; MEDIA: R2Bucket; RENDER_QUEUE: Queue<RenderMessage>; RENDERER: DurableObjectNamespace };
type JobRecord = { jobId: string; status: 'queued'|'running'|'done'|'failed'; createdAt: string; updatedAt: string; config: Record<string, unknown>; outputs?: Array<{preset:string;key:string}>; error?: string };

const json = (data: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(data), { ...init, headers: { 'content-type':'application/json; charset=utf-8', ...(init.headers || {}) } });
const bad = (message: string, status = 400) => json({ error: message }, { status });
const safeKey = (key: string) => { if (!key || key.includes('..') || key.startsWith('/')) throw new Error('Invalid object key'); return key; };

async function putJob(env: Env, job: JobRecord) {
  job.updatedAt = new Date().toISOString();
  await env.MEDIA.put(`jobs/${job.jobId}.json`, JSON.stringify(job), { httpMetadata: { contentType: 'application/json' } });
}
async function getJob(env: Env, id: string) {
  const obj = await env.MEDIA.get(`jobs/${id}.json`); return obj ? JSON.parse(await obj.text()) as JobRecord : null;
}

export class RenderContainer extends Container { defaultPort = 8080; sleepAfter = '30s'; }
(RenderContainer as any).outboundByHost = {
  'r2.local': async (request: Request, env: Env) => {
    const url = new URL(request.url); const key = safeKey(decodeURIComponent(url.pathname.slice(1)));
    if (request.method === 'GET') {
      const obj = await env.MEDIA.get(key); if (!obj) return new Response('Not found', { status: 404 });
      const headers = new Headers(); obj.writeHttpMetadata(headers); headers.set('etag', obj.httpEtag); return new Response(obj.body, { headers });
    }
    if (request.method === 'PUT') {
      if (!request.body) return new Response('Missing body', { status: 400 });
      await env.MEDIA.put(key, request.body, { httpMetadata: { contentType: request.headers.get('content-type') || 'application/octet-stream' } });
      return new Response(null, { status: 204 });
    }
    return new Response('Method not allowed', { status: 405 });
  },
};

async function api(request: Request, env: Env) {
  const url = new URL(request.url), path = url.pathname;
  if (request.method === 'GET' && path === '/api/health') return json({ ok: true });
  if (request.method === 'POST' && path === '/api/upload/create') {
    const body = await request.json<{key?:string;contentType?:string}>(); if (!body.key) return bad('Missing key');
    const upload = await env.MEDIA.createMultipartUpload(safeKey(body.key), { httpMetadata: { contentType: body.contentType || 'video/mp4' } });
    return json({ key: upload.key, uploadId: upload.uploadId });
  }
  if (request.method === 'PUT' && path === '/api/upload/part') {
    const key = safeKey(url.searchParams.get('key') || ''), uploadId = url.searchParams.get('uploadId'), partNumber = Number(url.searchParams.get('partNumber'));
    if (!uploadId || !Number.isInteger(partNumber) || partNumber < 1 || !request.body) return bad('Invalid part upload');
    try { return json(await env.MEDIA.resumeMultipartUpload(key, uploadId).uploadPart(partNumber, request.body)); }
    catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
  }
  if (request.method === 'POST' && path === '/api/upload/complete') {
    const body = await request.json<{key?:string;uploadId?:string;parts?:R2UploadedPart[]}>();
    if (!body.key || !body.uploadId || !Array.isArray(body.parts)) return bad('Invalid completion request');
    try { const obj = await env.MEDIA.resumeMultipartUpload(safeKey(body.key), body.uploadId).complete(body.parts); return json({ key: obj.key, etag: obj.httpEtag }); }
    catch (e) { return bad(e instanceof Error ? e.message : String(e)); }
  }
  if (request.method === 'POST' && path === '/api/render') {
    const config = await request.json<Record<string, unknown>>(); const layout = config.layout, outputs = config.outputs;
    const videoA = config.videoA as Record<string, unknown> | undefined, videoB = config.videoB as Record<string, unknown> | null | undefined;
    if (layout !== 'single' && layout !== 'split-full') return bad('Unsupported layout');
    if (!videoA?.key || (layout === 'split-full' && !videoB?.key) || !Array.isArray(outputs) || outputs.length === 0) return bad('Incomplete render configuration');
    const jobId = crypto.randomUUID(), now = new Date().toISOString();
    const job: JobRecord = { jobId, status:'queued', createdAt:now, updatedAt:now, config }; await putJob(env, job); await env.RENDER_QUEUE.send({ jobId, config });
    return json({ jobId, status:'queued' }, { status:202 });
  }
  const jobMatch = path.match(/^\/api\/jobs\/([a-f0-9-]+)$/i);
  if (request.method === 'GET' && jobMatch) { const job = await getJob(env, jobMatch[1]); return job ? json(job) : bad('Job not found', 404); }
  if (request.method === 'GET' && path.startsWith('/api/files/')) {
    const key = safeKey(decodeURIComponent(path.slice('/api/files/'.length))), obj = await env.MEDIA.get(key); if (!obj) return new Response('Not found', { status:404 });
    const headers = new Headers(); obj.writeHttpMetadata(headers); headers.set('content-disposition', `attachment; filename="${key.split('/').pop() || 'video.mp4'}"`); return new Response(obj.body, { headers });
  }
  return bad('Not found', 404);
}

export default {
  async fetch(request: Request, env: Env) { return new URL(request.url).pathname.startsWith('/api/') ? api(request, env) : env.ASSETS.fetch(request); },
  async queue(batch: MessageBatch<RenderMessage>, env: Env) {
    for (const message of batch.messages) {
      const { jobId, config } = message.body; const job = await getJob(env, jobId); if (!job) { message.ack(); continue; }
      try {
        job.status = 'running'; await putJob(env, job);
        const container = (env.RENDERER as any).getByName(`job-${jobId}`);
        const response = await container.fetch('http://container/render', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ jobId, config }) });
        const payload = await response.json() as { error?: string; outputs?: Array<{preset:string;key:string}> };
        if (!response.ok) throw new Error(payload?.error || `Renderer HTTP ${response.status}`);
        job.status='done'; job.outputs=payload.outputs || []; await putJob(env, job); message.ack();
      } catch (e) {
        job.status='failed'; job.error=e instanceof Error ? e.message : String(e); await putJob(env, job); message.retry({ delaySeconds:5 });
      }
    }
  },
} satisfies ExportedHandler<Env, RenderMessage>;
