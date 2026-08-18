import { useEffect, useMemo, useRef, useState } from 'react';

type Layout = 'single' | 'split-full';
type Slot = 'A' | 'B';
type AudioMode = 'a' | 'b' | 'mix';
type OutputPreset = 'clean' | 'plate' | 'sponsor' | 'combined';
type SponsorType = 'none' | 'winline' | 'difference';
type Transform = { zoom: number; panX: number; panY: number };
type Position = { x: number; y: number };
type ClipState = {
  file: File | null;
  url: string;
  key: string;
  duration: number;
  trimStart: number;
  trimEnd: number;
  single: Transform;
  split: Transform;
  full: Transform;
};
type PlateState = {
  enabled: boolean;
  text: string;
  position: Position;
  backgroundColor: string;
  borderColor: string;
  borderEnabled: boolean;
  textColor: string;
  wordColors: Record<number, string>;
  fontSize: number;
  maxWidth: number;
  radius: number;
  paddingX: number;
  paddingY: number;
};
type SponsorState = {
  type: SponsorType;
  position: Position;
  scale: number;
};

const DEFAULT_TRANSFORM: Transform = { zoom: 1, panX: 0, panY: 0 };
const blankClip = (): ClipState => ({
  file: null,
  url: '',
  key: '',
  duration: 0,
  trimStart: 0,
  trimEnd: 0,
  single: { ...DEFAULT_TRANSFORM },
  split: { ...DEFAULT_TRANSFORM },
  full: { ...DEFAULT_TRANSFORM },
});
const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
const uid = () => crypto.randomUUID();
const fmtTime = (sec: number) => {
  const s = Number.isFinite(sec) ? sec : 0;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
};
const sponsorDefaults: Record<Exclude<SponsorType, 'none'>, Position> = {
  winline: { x: 740 / 1080, y: 336 / 1920 },
  difference: { x: 626 / 1080, y: 336 / 1920 },
};

async function readDuration(file: File) {
  return await new Promise<number>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const d = video.duration;
      URL.revokeObjectURL(url);
      resolve(Number.isFinite(d) ? d : 0);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Не удалось прочитать видео'));
    };
    video.src = url;
  });
}

async function uploadMultipart(file: File, key: string, progress: (value: number) => void) {
  const create = await fetch('/api/upload/create', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, contentType: file.type || 'video/mp4' }),
  });
  if (!create.ok) throw new Error(await create.text());
  const { uploadId } = await create.json();
  const partSize = 8 * 1024 * 1024;
  const count = Math.ceil(file.size / partSize);
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let i = 0; i < count; i++) {
    const part = file.slice(i * partSize, Math.min((i + 1) * partSize, file.size));
    const response = await fetch(
      `/api/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${i + 1}`,
      { method: 'PUT', body: part },
    );
    if (!response.ok) throw new Error(await response.text());
    parts.push(await response.json());
    progress((i + 1) / count);
  }
  const complete = await fetch('/api/upload/complete', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ key, uploadId, parts }),
  });
  if (!complete.ok) throw new Error(await complete.text());
}

function VideoLayer({ clip, transform, active, onTransform }: {
  clip: ClipState;
  transform: Transform;
  active: boolean;
  onTransform: (value: Transform) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const start = useRef<{ x: number; y: number; transform: Transform } | null>(null);
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!active) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      start.current = { x: e.clientX, y: e.clientY, transform: { ...transform } };
    }
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
      onTransform({ ...transform, zoom: clamp((pinch.current.zoom * distance) / pinch.current.distance, 1, 4) });
      return;
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
    pointers.current.delete(e.pointerId);
    start.current = null;
    pinch.current = null;
  };

  return (
    <div ref={host} className={`videoLayer ${active ? 'active' : ''}`} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {clip.url ? (
        <video src={clip.url} muted loop autoPlay playsInline style={{ transform: `translate(${-transform.panX * 18}%, ${-transform.panY * 18}%) scale(${transform.zoom})` }} />
      ) : (
        <div className="emptyVideo">ДОБАВЬ ВИДЕО</div>
      )}
      {active && <div className="activeFrame" />}
    </div>
  );
}

function DraggableOverlay({ stageRef, position, onPosition, className, children }: {
  stageRef: React.RefObject<HTMLDivElement | null>;
  position: Position;
  onPosition: (value: Position) => void;
  className: string;
  children: React.ReactNode;
}) {
  const start = useRef<{ px: number; py: number; x: number; y: number } | null>(null);
  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, x: position.x, y: position.y };
  };
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || !stageRef.current) return;
    e.stopPropagation();
    const rect = stageRef.current.getBoundingClientRect();
    onPosition({
      x: clamp(start.current.x + (e.clientX - start.current.px) / rect.width, 0, 0.95),
      y: clamp(start.current.y + (e.clientY - start.current.py) / rect.height, 0, 0.95),
    });
  };
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    start.current = null;
  };
  return (
    <div className={`dragOverlay ${className}`} style={{ left: `${position.x * 100}%`, top: `${position.y * 100}%` }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
      {children}
    </div>
  );
}

function StyledPlateText({ text, baseColor, wordColors }: { text: string; baseColor: string; wordColors: Record<number, string> }) {
  let wordIndex = 0;
  const parts = text.toUpperCase().split(/(\s+)/);
  return <>{parts.map((part, index) => {
    if (!part) return null;
    if (/^\s+$/.test(part)) {
      const newLines = (part.match(/\n/g) || []).length;
      if (newLines) return <span key={index}>{Array.from({ length: newLines }, (_, i) => <br key={i} />)}</span>;
      return <span key={index}> </span>;
    }
    const current = wordIndex++;
    return <span key={index} style={{ color: wordColors[current] || baseColor }}>{part}</span>;
  })}</>;
}

function SponsorBadge({ type }: { type: Exclude<SponsorType, 'none'> }) {
  return (
    <div className={`sponsorBadge ${type === 'difference' ? 'difference' : ''}`}>
      <span>{type === 'winline' ? 'WINLINE' : 'ДЕЛАЕТ РАЗНИЦУ'}</span><b />
    </div>
  );
}

function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<Layout>('single');
  const [a, setA] = useState<ClipState>(blankClip);
  const [b, setB] = useState<ClipState>(blankClip);
  const [activeSlot, setActiveSlot] = useState<Slot>('A');
  const [previewMode, setPreviewMode] = useState<'split' | 'full'>('split');
  const [audioMode, setAudioMode] = useState<AudioMode>('b');
  const [plate, setPlate] = useState<PlateState>({
    enabled: true,
    text: 'МЕНДЕШ ОТКАЗАЛСЯ ЖАТЬ РУКУ НЕЙМАРУ',
    position: { x: 0.08, y: 0.10 },
    backgroundColor: '#111111',
    borderColor: '#ff5b11',
    borderEnabled: true,
    textColor: '#ffffff',
    wordColors: {},
    fontSize: 52,
    maxWidth: 860,
    radius: 18,
    paddingX: 24,
    paddingY: 12,
  });
  const [sponsor, setSponsor] = useState<SponsorState>({ type: 'winline', position: sponsorDefaults.winline, scale: 1 });
  const [outputs, setOutputs] = useState<OutputPreset[]>(['combined']);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [jobId, setJobId] = useState('');
  const [jobStatus, setJobStatus] = useState('');
  const [resultFiles, setResultFiles] = useState<Array<{ preset: string; key: string }>>([]);
  const [error, setError] = useState('');

  const plateWords = useMemo(() => plate.text.trim().split(/\s+/).filter(Boolean), [plate.text]);

  const setFile = async (slot: Slot, file?: File) => {
    if (!file) return;
    try {
      const duration = await readDuration(file);
      const next = { ...blankClip(), file, url: URL.createObjectURL(file), duration, trimEnd: duration };
      if (slot === 'A') setA(prev => { if (prev.url) URL.revokeObjectURL(prev.url); return next; });
      else setB(prev => { if (prev.url) URL.revokeObjectURL(prev.url); return next; });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
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

  const selectSponsor = (type: SponsorType) => {
    if (type === 'none') return setSponsor(v => ({ ...v, type }));
    setSponsor({ type, position: sponsorDefaults[type], scale: 1 });
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
    setUploading(true);
    setProgress(0);
    setError('');
    setResultFiles([]);
    setJobId('');
    try {
      const count = layout === 'single' ? 1 : 2;
      const nextA = await uploadClip(a, 0, 1 / count);
      setA(nextA);
      const nextB = layout === 'split-full' ? await uploadClip(b, 1 / count, 1 / count) : b;
      if (layout === 'split-full') setB(nextB);
      const response = await fetch('/api/render', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          layout,
          videoA: { key: nextA.key, sourceDuration: nextA.duration, trimStart: nextA.trimStart, trimEnd: nextA.trimEnd, single: nextA.single, split: nextA.split },
          videoB: layout === 'split-full' ? { key: nextB.key, sourceDuration: nextB.duration, trimStart: nextB.trimStart, trimEnd: nextB.trimEnd, split: nextB.split, full: nextB.full } : null,
          splitRatio: 0.5,
          audioMode,
          plate: {
            ...plate,
            text: plate.text.toUpperCase(),
            x: plate.position.x,
            y: plate.position.y,
          },
          sponsor: {
            type: sponsor.type,
            x: sponsor.position.x,
            y: sponsor.position.y,
            scale: sponsor.scale,
          },
          outputs,
        }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      setJobId(result.jobId);
      setJobStatus('queued');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  useEffect(() => {
    if (!jobId) return;
    let stopped = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/jobs/${jobId}`);
        if (!response.ok || stopped) return;
        const job = await response.json();
        setJobStatus(job.status);
        if (job.status === 'done') return setResultFiles(job.outputs || []);
        if (job.status === 'failed') return setError(job.error || 'Ошибка рендера');
        setTimeout(poll, 2000);
      } catch {
        if (!stopped) setTimeout(poll, 3000);
      }
    };
    poll();
    return () => { stopped = true; };
  }, [jobId]);

  const trim = (slot: Slot, field: 'trimStart' | 'trimEnd', value: number) => {
    const setter = slot === 'A' ? setA : setB;
    setter(v => field === 'trimStart'
      ? { ...v, trimStart: clamp(value, 0, Math.max(0, v.trimEnd - 0.1)) }
      : { ...v, trimEnd: clamp(value, v.trimStart + 0.1, v.duration) });
  };

  return <main>
    <header className="topbar"><div><div className="eyebrow">ZNAMBO</div><h1>VIDEO RENDERER</h1></div><span className="resolution">1080 × 1920</span></header>

    <section className="card compact"><div className="segmented"><button className={layout === 'single' ? 'selected' : ''} onClick={() => setLayout('single')}>ОДНО ВИДЕО</button><button className={layout === 'split-full' ? 'selected' : ''} onClick={() => setLayout('split-full')}>ДВА → FULL</button></div></section>

    <section className="stageWrap"><div ref={stageRef} className="stage">
      {layout === 'single' ? <VideoLayer clip={a} transform={a.single} active onTransform={v => setA(x => ({ ...x, single: v }))} />
      : previewMode === 'full' ? <VideoLayer clip={b} transform={b.full} active onTransform={v => setB(x => ({ ...x, full: v }))} />
      : <><div className="half top" onClick={() => setActiveSlot('A')}><VideoLayer clip={a} transform={a.split} active={activeSlot === 'A'} onTransform={v => setA(x => ({ ...x, split: v }))} /></div><div className="half bottom" onClick={() => setActiveSlot('B')}><VideoLayer clip={b} transform={b.split} active={activeSlot === 'B'} onTransform={v => setB(x => ({ ...x, split: v }))} /></div></>}

      {plate.enabled && plate.text.trim() && <DraggableOverlay stageRef={stageRef} position={plate.position} onPosition={position => setPlate(v => ({ ...v, position }))} className="plateDrag">
        <div className="platePreview" style={{ backgroundColor: plate.backgroundColor, borderColor: plate.borderEnabled ? plate.borderColor : 'transparent', borderRadius: `${Math.max(4, plate.radius / 3)}px`, maxWidth: `${(plate.maxWidth / 1080) * 100}%`, padding: `${Math.max(3, plate.paddingY / 3)}px ${Math.max(5, plate.paddingX / 3)}px`, fontSize: `${Math.max(10, plate.fontSize / 3)}px` }}>
          <StyledPlateText text={plate.text} baseColor={plate.textColor} wordColors={plate.wordColors} />
        </div>
      </DraggableOverlay>}

      {sponsor.type !== 'none' && <DraggableOverlay stageRef={stageRef} position={sponsor.position} onPosition={position => setSponsor(v => ({ ...v, position }))} className="sponsorDrag">
        <div style={{ transform: `scale(${sponsor.scale})`, transformOrigin: 'top left' }}><SponsorBadge type={sponsor.type} /></div>
      </DraggableOverlay>}
    </div><div className="gestureHint">Видео: 1 палец — двигать · 2 пальца — зум · Плашку и лого тоже можно двигать</div></section>

    {layout === 'split-full' && <section className="card compact"><div className="row between"><div><div className="label">ПРЕВЬЮ B</div><div className="sub">Отдельный кроп для split и fullscreen</div></div><div className="segmented small"><button className={previewMode === 'split' ? 'selected' : ''} onClick={() => setPreviewMode('split')}>SPLIT</button><button className={previewMode === 'full' ? 'selected' : ''} onClick={() => { setPreviewMode('full'); setActiveSlot('B'); }}>B FULL</button></div></div></section>}

    <section className="card"><h2>КАДР</h2><div className="controls4"><button onClick={() => setActiveTransform({ ...activeTransform, zoom: clamp(activeTransform.zoom - 0.1, 1, 4) })}>− ЗУМ</button><button onClick={() => setActiveTransform({ ...activeTransform, zoom: clamp(activeTransform.zoom + 0.1, 1, 4) })}>+ ЗУМ</button><button onClick={() => setActiveTransform({ ...activeTransform, panX: 0, panY: 0 })}>ЦЕНТР</button><button onClick={() => setActiveTransform({ ...DEFAULT_TRANSFORM })}>RESET</button></div><div className="zoomReadout">Zoom {Math.round(activeTransform.zoom * 100)}% · X {activeTransform.panX.toFixed(2)} · Y {activeTransform.panY.toFixed(2)}</div></section>

    <section className="card"><h2>ВИДЕО</h2><FileRow slot="A" clip={a} onFile={setFile} />{layout === 'split-full' && <FileRow slot="B" clip={b} onFile={setFile} />}</section>

    <section className="card"><h2>ОБРЕЗКА</h2>{a.file && <TrimRow slot="A" clip={a} onChange={trim} />}{layout === 'split-full' && b.file && <TrimRow slot="B" clip={b} onChange={trim} />}{layout === 'split-full' && a.file && b.file && <div className="note">После окончания A видео B автоматически продолжит с текущего момента во весь экран.</div>}</section>

    {layout === 'split-full' && <section className="card"><h2>ЗВУК</h2><div className="segmented"><button className={audioMode === 'a' ? 'selected' : ''} onClick={() => setAudioMode('a')}>A</button><button className={audioMode === 'b' ? 'selected' : ''} onClick={() => setAudioMode('b')}>B</button><button className={audioMode === 'mix' ? 'selected' : ''} onClick={() => setAudioMode('mix')}>A + B</button></div></section>}

    <section className="card"><div className="row between"><h2>ТЕКСТОВАЯ ПЛАШКА</h2><label className="switch"><input type="checkbox" checked={plate.enabled} onChange={e => setPlate(v => ({ ...v, enabled: e.target.checked }))} /><span /></label></div>
      <textarea className="textInput textarea" rows={3} value={plate.text} onChange={e => setPlate(v => ({ ...v, text: e.target.value, wordColors: {} }))} placeholder={'ТЕКСТ ПЛАШКИ\nМОЖНО ПЕРЕНОСИТЬ'} />
      <div className="controlGrid">
        <ColorControl label="ФОН" value={plate.backgroundColor} onChange={backgroundColor => setPlate(v => ({ ...v, backgroundColor }))} presets={['#111111', '#ffffff', '#ff5b11']} />
        <ColorControl label="ТЕКСТ" value={plate.textColor} onChange={textColor => setPlate(v => ({ ...v, textColor }))} presets={['#ffffff', '#111111', '#ff5b11']} />
        <ColorControl label="ОБВОДКА" value={plate.borderColor} onChange={borderColor => setPlate(v => ({ ...v, borderColor }))} presets={['#ff5b11', '#111111', '#ffffff']} />
        <label className="miniSwitch"><input type="checkbox" checked={plate.borderEnabled} onChange={e => setPlate(v => ({ ...v, borderEnabled: e.target.checked }))} /><span>Обводка</span></label>
      </div>
      <div className="rangeRow"><label>Размер <b>{plate.fontSize}px</b></label><input type="range" min="30" max="110" value={plate.fontSize} onChange={e => setPlate(v => ({ ...v, fontSize: Number(e.target.value) }))} /></div>
      <div className="rangeRow"><label>Ширина <b>{plate.maxWidth}px</b></label><input type="range" min="300" max="1000" value={plate.maxWidth} onChange={e => setPlate(v => ({ ...v, maxWidth: Number(e.target.value) }))} /></div>
      <div className="positionReadout">X {Math.round(plate.position.x * 1080)} · Y {Math.round(plate.position.y * 1920)}</div>
      {!!plateWords.length && <><div className="sub sectionSub">ЦВЕТ КАЖДОГО СЛОВА</div><div className="wordPalette">{plateWords.map((word, index) => <label key={`${word}-${index}`}><span>{word.toUpperCase()}</span><input type="color" value={plate.wordColors[index] || plate.textColor} onChange={e => setPlate(v => ({ ...v, wordColors: { ...v.wordColors, [index]: e.target.value } }))} /></label>)}</div></>}
    </section>

    <section className="card"><h2>ЛОГО WINLINE</h2><div className="segmented sponsorChoice"><button className={sponsor.type === 'none' ? 'selected' : ''} onClick={() => selectSponsor('none')}>НЕТ</button><button className={sponsor.type === 'winline' ? 'selected' : ''} onClick={() => selectSponsor('winline')}>WINLINE</button><button className={sponsor.type === 'difference' ? 'selected' : ''} onClick={() => selectSponsor('difference')}>ДЕЛАЕТ РАЗНИЦУ</button></div>
      {sponsor.type !== 'none' && <><div className="rangeRow"><label>Размер <b>{Math.round(sponsor.scale * 100)}%</b></label><input type="range" min="0.5" max="2" step="0.05" value={sponsor.scale} onChange={e => setSponsor(v => ({ ...v, scale: Number(e.target.value) }))} /></div><div className="positionReadout">X {Math.round(sponsor.position.x * 1080)} · Y {Math.round(sponsor.position.y * 1920)}</div><button className="resetPosition" onClick={() => sponsor.type !== 'none' && setSponsor(v => ({ ...v, position: sponsorDefaults[sponsor.type as Exclude<SponsorType, 'none'>], scale: 1 }))}>ВЕРНУТЬ ЭТАЛОННОЕ ПОЛОЖЕНИЕ</button></>}
    </section>

    <section className="card"><h2>ВЕРСИИ НА ВЫХОДЕ</h2>
      <OutputRow title="Чистая" sub="без графики" checked={outputs.includes('clean')} onClick={() => toggleOutput('clean')} />
      <OutputRow title="Только плашка" sub="текстовая плашка без лого" checked={outputs.includes('plate')} onClick={() => toggleOutput('plate')} />
      <OutputRow title="Только лого" sub={sponsor.type === 'none' ? 'выбери лого выше' : sponsor.type === 'winline' ? 'WINLINE' : 'ДЕЛАЕТ РАЗНИЦУ'} checked={outputs.includes('sponsor')} onClick={() => toggleOutput('sponsor')} />
      <OutputRow title="Плашка + лого" sub="оба слоя" checked={outputs.includes('combined')} onClick={() => toggleOutput('combined')} />
    </section>

    {error && <div className="error">{error}</div>}
    {jobId && <section className="card"><div className="row between"><h2>РЕНДЕР</h2><span className={`status ${jobStatus}`}>{jobStatus}</span></div>{resultFiles.map(file => <a className="download" key={file.key} href={`/api/files/${encodeURIComponent(file.key)}`}><span>{file.preset.toUpperCase()}.MP4</span><strong>СКАЧАТЬ</strong></a>)}</section>}
    {uploading && <div className="progress"><i style={{ width: `${progress}%` }} /></div>}
    <button className="renderButton" disabled={!canRender || uploading} onClick={render}>{uploading ? `ЗАГРУЗКА ${Math.round(progress)}%` : `РЕНДЕР ${outputs.length || ''}`}</button>
    <div className="safeBottom" />
  </main>;
}

function ColorControl({ label, value, onChange, presets }: { label: string; value: string; onChange: (value: string) => void; presets: string[] }) {
  return <div className="colorControl"><span>{label}</span><div className="swatches">{presets.map(color => <button key={color} type="button" aria-label={color} className={value.toLowerCase() === color.toLowerCase() ? 'active' : ''} style={{ background: color }} onClick={() => onChange(color)} />)}<label className="customColor"><input type="color" value={value} onChange={e => onChange(e.target.value)} /><i /></label></div></div>;
}

function FileRow({ slot, clip, onFile }: { slot: Slot; clip: ClipState; onFile: (slot: Slot, file?: File) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return <div className="fileRow" onClick={() => input.current?.click()}><input ref={input} type="file" accept="video/*" hidden onChange={e => onFile(slot, e.target.files?.[0])} /><span><b>{slot}</b><small>{clip.file?.name || 'Выбрать видео'}</small></span><strong>{clip.file ? 'ЗАМЕНИТЬ' : 'ДОБАВИТЬ'}</strong></div>;
}

function TrimRow({ slot, clip, onChange }: { slot: Slot; clip: ClipState; onChange: (slot: Slot, field: 'trimStart' | 'trimEnd', value: number) => void }) {
  return <div className="trimRow"><b>{slot}</b><label>IN<input type="number" step="0.1" value={clip.trimStart.toFixed(1)} onChange={e => onChange(slot, 'trimStart', Number(e.target.value))} /></label><label>OUT<input type="number" step="0.1" value={clip.trimEnd.toFixed(1)} onChange={e => onChange(slot, 'trimEnd', Number(e.target.value))} /></label><span>{fmtTime(clip.duration)}</span></div>;
}

function OutputRow({ title, sub, checked, onClick }: { title: string; sub: string; checked: boolean; onClick: () => void }) {
  return <button className={`outputRow ${checked ? 'checked' : ''}`} onClick={onClick}><span className="check">{checked ? '✓' : ''}</span><span><b>{title}</b><small>{sub}</small></span></button>;
}

export default App;
