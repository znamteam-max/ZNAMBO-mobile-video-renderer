# ZNAMBO Mobile Video Renderer

Mobile-first 1080×1920 video compositor for fast social-media renders from a phone.

## MVP

- Single-video 9:16 canvas.
- Touch drag + pinch zoom crop for 16:9, 4:5 and vertical source files.
- Two-video `Split → Full`: A and B run 50/50, then B expands to fullscreen when A ends and continues from the same timestamp.
- Independent crop for A split, B split and B fullscreen.
- IN/OUT trim controls.
- Split audio: A, B or A+B.
- Uppercase text badge.
- Winline overlay position calibrated from the supplied 1080×1920 reference.
- Clean / text badge / Winline output versions.
- Multipart uploads to R2.
- Async jobs through Cloudflare Queues.
- FFmpeg renderer in Cloudflare Containers.
- Render status polling and MP4 download back to the phone.

## Architecture

`Phone → Worker → R2 → Queue → FFmpeg Container → R2 → Phone`

The Worker serves the mobile UI, handles multipart uploads, queues jobs and exposes job/download endpoints. The Container downloads source files through a Cloudflare outbound R2 binding, renders with FFmpeg and uploads finished MP4s back to R2.

## Cloudflare resources

- R2: `znambo-mobile-video-renderer-media`
- Queue: `znambo-mobile-video-renderer-jobs`
- DLQ: `znambo-mobile-video-renderer-dlq`
- Container/Durable Object binding: `RENDERER`

## GitHub secrets required for deploy

- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_API_TOKEN`

The included GitHub Action creates the main R2 bucket and render queue if missing, then runs `wrangler deploy` to deploy the Worker and FFmpeg Container.

## PF Din Text Comp Pro Bold Italic

The repository is currently public, so the licensed font is intentionally not committed. At render time the Container checks for this private R2 object:

`assets/pf-din-text-comp-pro-bold-italic.ttf`

If it is absent, a condensed bold italic fallback is used. As soon as the licensed font is uploaded privately to R2, server renders automatically use it.

## Local UI

```bash
npm install
npm run dev
```

Full Cloudflare deployment requires Docker and Wrangler authentication:

```bash
npm install
npm run deploy
```
