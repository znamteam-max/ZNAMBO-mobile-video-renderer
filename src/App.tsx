import { useEffect, useMemo, useRef, useState } from 'react';

type Layout = 'single' | 'split-full';
type Slot = 'A' | 'B';
type AudioMode = 'a' | 'b' | 'mix';
type OutputPreset = 'clean' | 'label' | 'winline';
type Transform = { zoom: number; panX: number; panY: number };
type ClipState = {
  file: File | null; url: string; key: string; duration: number; trimStart: number; trimEnd: number;
  single: Transform; split: Transform; full: Transform;
};

const DEFAULT_TRANSFORM: Transform = { zoom: 1, panX: 0, panY: 0 };
const blankClip = (): ClipState => ({
  file: null, url: '', key: '', duration: 0, trimStart: 0, trimEnd: 0,
  single: { ...DEFAULT_TRANSFORM }, split: { ...DEFAULT_TRANSFORM }, full: { ...DEFAULT_TRANSFORM },
});
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const uid = () => crypto.randomUUID();
const fmtTime = (sec: number) => {
  const s = Number.isFinite(sec) ? sec : 0;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};

async function readDuration(file: File) {
  return await new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => { const d = video.duration; URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : 0); };
    video.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Не удалось прочитать видео')); };
    video.src = url;
  });
}

async function uploadMultipart(file: File, key: string, progress: (value: number) => void) {
  const create = await fetch('/api/upload/create', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, contentType: file.type || 'video/mp4' }),
  });
  if (!create.ok) throw new Error(await create.text());
  const { uploadId } = await create.json();
  const partSize = 8 * 1024 * 1024;
  const count = Math.ceil(file.size / partSize);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let i = 0; i < count; i++) {
    const part = file.slice(i * partSize, Math.min((i + 1) * partSize, file.size));
    const response = await fetch(`/api/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${i + 1}`, { method: 'PUT', body: part });
    if (!response.ok) throw new Error(await response.text());
    parts.push(await response.json());
    progress((i + 1) / count);
  }
  const complete = await fetch('/api/upload/complete', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, uploadId, parts }),
  });
  if (!complete.ok) throw new Error(await complete.text());
}

function VideoLayer({ clip, transform, active, onTransform }: {
  clip: ClipState; transform: Transform; active: boolean; onTransform: (value: Transform) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ x: number; y: number; transform: Transform } | null>(null);
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) start.current = { x: e.clientX, y: e.clientY, transform: { ...transform } };
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: transform.zoom };
    }
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active || !pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      return onTransform({ ...transform, zoom: clamp(pinch.current.zoom * distance / pinch.current.distance, 1, 4) });
    }
    if (pointers.current.size === 1 && start.current && host.current) {
      const rect = host.current.getBoundingClientRect();
      onTransform({
        ...start.current.transform,
        panX: clamp(start.current.transform.panX - ((e.clientX - start.current.x) / rect.width) * 1.5, -1, 1),
        panY: clamp(start.current.transform.panY - ((e.clientY - start.current.y) / rect.height) * 1.5, -1, 1),
      });
    }
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(e.pointerId); start.current = null; pinch.current = null;
  };

  return <div ref={host} className={`videoLayer ${active ? 'active' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
    {clip.url ? <video src={clip.url} muted loop autoPlay playsInline style={{ transform: `translate(${-transform.panX * 18}%, ${-transform.panY * 18}%) scale(${transform.zoom})` }} /> : <div className="emptyVideo">ДОБАВЬ ВИДЕО</div>}
    {active && <div className="activeFrame" />}
  </div>;
}

function App() {
  const [layout, setLayout] = useState<Layout>('single');
  const [a, setA] = useState<ClipState>(blankClip);
  const [b, setB] = useState<ClipState>(blankClip);
  const [activeSlot, setActiveSlot] = useState<Slot>('A');
  const [previewMode, setPreviewMode] = useState<'split' | 'full'>('split');
  const [headline, setHeadline] = useState('ДЕЛАЕТ РАЗНИЦУ');
  const [headlineEnabled, setHeadlineEnabled] = useState(true);
  const [audioMode, setAudioMode] = useState<AudioMode>('b');
  const [outputs, setOutputs] = useState<OutputPreset[]>(['label', 'winline']);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState('');
  const [jobStatus, setJobStatus] = useState('');
  const [resultFiles, setResultFiles] = useState<Array<{ preset: string; key: string }>>([]);
  const [error, setError] = useState('');

  const setFile = async (slot: Slot, file?: File) => {
    if (!file) return;
    try {
      const duration = await readDuration(file);
      const next = { ...blankClip(), file, url: URL.createObjectURL(file), duration, trimEnd: duration };
      if (slot === 'A') setA(prev => { if (prev.url) URL.revokeObjectURL(prev.url); return next; });
      else setB(prev => { if (prev.url) URL.revokeObjectURL(prev.url); return next; });
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };

  const activeTransform = useMemo(() => {
    if (layout === 'single') return a.single;
    if (activeSlot === 'A') return a.split;
    return previewMode === 'split' ? b.split : b.full;
  }, [layout, activeSlot, previewMode, a.single, a.split, b.split, b.full]);

  const setActiveTransform = (value: Transform) => {
    if (layout === 'single') setA(v => ({ ...v, single: value }));
    else if (activeSlot === 'A') setA(v => ({ ...v, split: value }));
    else if (previewMode === 'split') setB(v => ({ ...v, split: value }));
    else setB(v => ({ ...v, full: value }));
  };

  const toggleOutput = (output: OutputPreset) => setOutputs(v => v.includes(output) ? v.filter(x => x !== output) : [...v, output]);
  const canRender = !!a.file && (layout === 'single' || !!b.file) && outputs.length > 0;

  const uploadClip = async (clip: ClipState, weightStart: number, weight: number) => {
    if (!clip.file || clip.key) return clip;
    const key = `uploads/${uid()}-${clip.file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await uploadMultipart(clip.file, key, p => setProgress((weightStart + p * weight) * 100));
    return { ...clip, key };
  };

  const render = async () => {
    if (!canRender) return;
    setUploading(true); setProgress(0); setError(''); setResultFiles([]); setJobId('');
    try {
      const count = layout === 'single' ? 1 : 2;
      const nextA = await uploadClip(a, 0, 1 / count); setA(nextA);
      const nextB = layout === 'split-full' ? await uploadClip(b, 1 / count, 1 / count) : b; if (layout === 'split-full') setB(nextB);
      const response = await fetch('/api/render', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          layout,
          videoA: { key: nextA.key, sourceDuration: nextA.duration, trimStart: nextA.trimStart, trimEnd: nextA.trimEnd, single: nextA.single, split: nextA.split },
          videoB: layout === 'split-full' ? { key: nextB.key, sourceDuration: nextB.duration, trimStart: nextB.trimStart, trimEnd: nextB.trimEnd, split: nextB.split, full: nextB.full } : null,
          splitRatio: .5, audioMode,
          headline: { enabled: headlineEnabled, text: headline.toUpperCase(), anchorRight: .88, y: .175 },
          outputs,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json(); setJobId(result.jobId); setJobStatus('queued');
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setUploading(false); }
  };

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`);
        if (!response.ok || stopped) return;
        const job = await response.json(); setJobStatus(job.status);
        if (job.status === 'done') return setResultFiles(job.outputs || []);
        if (job.status === 'failed') return setError(job.error || 'Ошибка рендера');
        setTimeout(poll, 2000);
      } catch { if (!stopped) setTimeout(poll, 3000); }
    };
    poll(); return () => { stopped = true; };
  }, [jobId]);

  const trim = (slot: Slot, field: 'trimStart' | 'trimEnd', value: number) => {
    const setter = slot === 'A' ? setA : setB;
    setter(v => field === 'trimStart'
      ? { ...v, trimStart: clamp(value, 0, Math.max(0, v.trimEnd - .1)) }
      : { ...v, trimEnd: clamp(value, v.trimStart + .1, v.duration) });
  };

  return <main>
    <header className="topbar"><div><div className="eyebrow">ZNAMBO</div><h1>VIDEO RENDERER</h1></div><span className="resolution">1080 × 1920</span></header>
    <section className="card compact"><div className="segmented"><button className={layout === 'single' ? 'selected' : ''} onClick={() => setLayout('single')}>ОДНО ВИДЕО</button><button className={layout === 'split-full' ? 'selected' : ''} onClick={() => setLayout('split-full')}>ДВА → FULL</button></div></section>

    <section className="stageWrap"><div className="stage">
      {layout === 'single' ? <VideoLayer clip={a} transform={a.single} active onTransform={v => setA(x => ({ ...x, single: v }))} />
      : previewMode === 'full' ? <VideoLayer clip={b} transform={b.full} active onTransform={v => setB(x => ({ ...x, full: v }))} />
      : <><div className="half top" onClick={() => setActiveSlot('A')}><VideoLayer clip={a} transform={a.split} active={activeSlot === 'A'} onTransform={v => setA(x => ({ ...x, split: v }))} /></div><div className="half bottom" onClick={() => setActiveSlot('B')}><VideoLayer clip={b} transform={b.split} active={activeSlot === 'B'} onTransform={v => setB(x => ({ ...x, split: v }))} /></div></>}
      {headlineEnabled && headline && <div className="headlinePreview"><span>{headline.toUpperCase()}</span><b /></div>}
    </div><div className="gestureHint">1 палец — двигать · 2 пальца — зум</div></section>

    {layout === 'split-full' && <section className="card compact"><div className="row between"><div><div className="label">ПРЕВЬЮ B</div><div className="sub">Отдельный кроп для split и fullscreen</div></div><div className="segmented small"><button className={previewMode === 'split' ? 'selected' : ''} onClick={() => setPreviewMode('split')}>SPLIT</button><button className={previewMode === 'full' ? 'selected' : ''} onClick={() => { setPreviewMode('full'); setActiveSlot('B'); }}>B FULL</button></div></div></section>}

    <section className="card"><h2>КАДР</h2><div className="controls4"><button onClick={() => setActiveTransform({ ...activeTransform, zoom: clamp(activeTransform.zoom - .1, 1, 4) })}>− ЗУМ</button><button onClick={() => setActiveTransform({ ...activeTransform, zoom: clamp(activeTransform.zoom + .1, 1, 4) })}>+ ЗУМ</button><button onClick={() => setActiveTransform({ ...activeTransform, panX: 0, panY: 0 })}>ЦЕНТР</button><button onClick={() => setActiveTransform({ ...DEFAULT_TRANSFORM })}>RESET</button></div><div className="zoomReadout">Zoom {Math.round(activeTransform.zoom * 100)}% · X {activeTransform.panX.toFixed(2)} · Y {activeTransform.panY.toFixed(2)}</div></section>

    <section className="card"><h2>ВИДЕО</h2><FileRow slot="A" clip={a} onFile={setFile} />{layout === 'split-full' && <FileRow slot="B" clip={b} onFile={setFile} />}</section>
    <section className="card"><h2>ОБРЕЗКА</h2>{a.file && <TrimRow slot="A" clip={a} onChange={trim} />}{layout === 'split-full' && b.file && <TrimRow slot="B" clip={b} onChange={trim} />}{layout === 'split-full' && a.file && b.file && <div className="note">После {fmtTime(Math.min(a.trimEnd - a.trimStart, b.trimEnd - b.trimStart))} видео B автоматически станет fullscreen и продолжится с того же момента.</div>}</section>

    <section className="card"><div className="row between"><h2>ТЕКСТОВАЯ ПЛАШКА</h2><label className="switch"><input type="checkbox" checked={headlineEnabled} onChange={e => setHeadlineEnabled(e.target.checked)} /><span /></label></div><input className="textInput" value={headline} maxLength={60} onChange={e => setHeadline(e.target.value)} /><div className="note">PF Din Text Comp Pro Bold Italic будет использоваться сервером после приватной загрузки файла шрифта в R2.</div></section>

    {layout === 'split-full' && <section className="card"><h2>ЗВУК</h2><div className="segmented">{(['a','b','mix'] as AudioMode[]).map(x => <button key={x} className={audioMode === x ? 'selected' : ''} onClick={() => setAudioMode(x)}>{x === 'mix' ? 'A + B' : x.toUpperCase()}</button>)}</div></section>}

    <section className="card"><h2>ВЕРСИИ НА ВЫХОДЕ</h2><OutputRow checked={outputs.includes('clean')} name="Чистая" detail="без графики" onClick={() => toggleOutput('clean')} /><OutputRow checked={outputs.includes('label')} name="Текстовая плашка" detail={headline.toUpperCase()} onClick={() => toggleOutput('label')} /><OutputRow checked={outputs.includes('winline')} name="Winline" detail="позиция по присланному эталону" onClick={() => toggleOutput('winline')} /></section>

    {error && <div className="error">{error}</div>}
    {uploading && <section className="card"><div className="row between"><b>ЗАГРУЗКА</b><span>{Math.round(progress)}%</span></div><div className="progress"><i style={{ width: `${progress}%` }} /></div></section>}
    {jobId && <section className="card"><div className="row between"><b>РЕНДЕР</b><span className={`status ${jobStatus}`}>{jobStatus}</span></div>{resultFiles.map(file => <a className="download" key={file.key} href={`/api/files/${encodeURIComponent(file.key)}`} download><span>{file.preset.toUpperCase()}</span><strong>СКАЧАТЬ MP4</strong></a>)}</section>}
    <button className="renderButton" disabled={!canRender || uploading} onClick={render}>{uploading ? 'ЗАГРУЖАЮ…' : `РЕНДЕР ${outputs.length}`}</button><div className="safeBottom" />
  </main>;
}

function FileRow({ slot, clip, onFile }: { slot: Slot; clip: ClipState; onFile: (slot: Slot, file?: File) => void }) {
  return <label className="fileRow"><span><b>{slot}</b><small>{clip.file ? `${clip.file.name} · ${fmtTime(clip.duration)}` : slot === 'A' ? 'основное видео' : 'нижнее → fullscreen'}</small></span><strong>{clip.file ? 'ЗАМЕНИТЬ' : '+ ДОБАВИТЬ'}</strong><input hidden type="file" accept="video/*" onChange={e => onFile(slot, e.target.files?.[0])} /></label>;
}
function TrimRow({ slot, clip, onChange }: { slot: Slot; clip: ClipState; onChange: (slot: Slot, field: 'trimStart' | 'trimEnd', value: number) => void }) {
  return <div className="trimRow"><b>{slot}</b><label>IN<input type="number" step="0.1" value={clip.trimStart.toFixed(1)} onChange={e => onChange(slot, 'trimStart', Number(e.target.value))} /></label><label>OUT<input type="number" step="0.1" value={clip.trimEnd.toFixed(1)} onChange={e => onChange(slot, 'trimEnd', Number(e.target.value))} /></label><span>{fmtTime(clip.trimEnd - clip.trimStart)}</span></div>;
}
function OutputRow({ checked, name, detail, onClick }: { checked: boolean; name: string; detail: string; onClick: () => void }) {
  return <button className={`outputRow ${checked ? 'checked' : ''}`} onClick={onClick}><span className="check">{checked ? '✓' : ''}</span><span><b>{name}</b><small>{detail}</small></span></button>;
}
export default App;
