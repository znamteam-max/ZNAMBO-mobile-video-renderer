#!/usr/bin/env python3
import json, os, shutil, subprocess, tempfile, traceback, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

PORT=int(os.environ.get('PORT','8080')); R2='http://r2.local/'; W,H,FPS=1080,1920,30
FALLBACK='/usr/share/fonts/truetype/dejavu/DejaVuSansCondensed-BoldOblique.ttf'

def clamp(v,a,b): return max(a,min(b,v))
def run(cmd):
    p=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    if p.returncode: raise RuntimeError('\n'.join(p.stderr.splitlines()[-35:]))
    return p.stdout

def probe(path):
    d=json.loads(run(['ffprobe','-v','error','-show_entries','format=duration:stream=codec_type,width,height','-of','json',str(path)]))
    return {'duration':float(d.get('format',{}).get('duration') or 0),'has_audio':any(x.get('codec_type')=='audio' for x in d.get('streams',[]))}
def r2url(key): return R2+urllib.parse.quote(key,safe='/')
def download(key,path):
    with urllib.request.urlopen(r2url(key),timeout=120) as r, open(path,'wb') as f: shutil.copyfileobj(r,f,1024*1024)
def upload(key,path):
    with open(path,'rb') as f:
        req=urllib.request.Request(r2url(key),data=f,method='PUT',headers={'content-type':'video/mp4','content-length':str(os.path.getsize(path))})
        urllib.request.urlopen(req,timeout=600).read()
def font(workdir):
    target=Path(workdir)/'pf-din.ttf'
    try:
        download('assets/pf-din-text-comp-pro-bold-italic.ttf',target)
        if target.stat().st_size>1000:return str(target)
    except Exception: pass
    return FALLBACK

def badge(text,workdir,font_path,right=.88,y=.175):
    text=(text or '').strip().upper()[:80]; height=50; orange=(255,91,17,255)
    f=ImageFont.truetype(font_path,32); tmp=Image.new('RGBA',(1500,height)); d=ImageDraw.Draw(tmp); box=d.textbbox((0,0),text,font=f)
    width=min(1000,max(140,box[2]-box[0]+64)); img=Image.new('RGBA',(width,height),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle((1,1,width-2,height-2),radius=23,fill=(18,18,18,238),outline=orange,width=4)
    cx,cy=width-24,height//2; d.ellipse((cx-16,cy-16,cx+16,cy+16),fill=orange)
    ty=(height-(box[3]-box[1]))/2-box[1]-1; d.text((14,ty),text,font=f,fill='white')
    p=Path(workdir)/'headline.png'; img.save(p); return str(p),int(W*right)-width,int(H*y)
def winline(workdir,font_path):
    width,height=215,53; orange=(255,91,17,255); img=Image.new('RGBA',(width,height),(0,0,0,0)); d=ImageDraw.Draw(img)
    d.rounded_rectangle((1,1,width-2,height-2),radius=24,fill=(18,18,18,238),outline=orange,width=4)
    cx,cy=width-25,height//2; d.ellipse((cx-17,cy-17,cx+17,cy+17),fill=orange)
    f=ImageFont.truetype(font_path,34); box=d.textbbox((0,0),'WINLINE',font=f); ty=(height-(box[3]-box[1]))/2-box[1]-1; d.text((13,ty),'WINLINE',font=f,fill='white')
    p=Path(workdir)/'winline.png'; img.save(p); return str(p),740,336

def tf(rw,rh,t):
    t=t or {}; z=clamp(float(t.get('zoom') or 1),1,4); x=clamp(float(t.get('panX') or 0),-1,1); y=clamp(float(t.get('panY') or 0),-1,1); ratio=rw/rh
    return f"scale=w='if(gt(a,{ratio:.10f}),-2,ceil({rw}*{z:.6f}/2)*2)':h='if(gt(a,{ratio:.10f}),ceil({rh}*{z:.6f}/2)*2,-2)',crop={rw}:{rh}:'(iw-ow)/2*(1+{x:.6f})':'(ih-oh)/2*(1+{y:.6f})',setsar=1,fps={FPS},format=yuv420p"
def clip(c,actual):
    s=clamp(float(c.get('trimStart') or 0),0,max(0,actual-.05)); e=clamp(float(c.get('trimEnd') or actual),s+.05,actual); return s,e,e-s

def overlay(cmd,filters,label,preset,headline,workdir,font_path,index):
    if preset=='winline':
        p,x,y=winline(workdir,font_path); cmd+=['-loop','1','-framerate',str(FPS),'-i',p]; filters.append(f'[{label}][{index}:v]overlay={x}:{y}:eof_action=repeat:shortest=0[vbrand]'); label='vbrand'; index+=1
    if preset=='label' and headline and headline.get('enabled',True):
        p,x,y=badge(headline.get('text',''),workdir,font_path,headline.get('anchorRight',.88),headline.get('y',.175)); cmd+=['-loop','1','-framerate',str(FPS),'-i',p]; filters.append(f'[{label}][{index}:v]overlay={x}:{y}:eof_action=repeat:shortest=0[vlabel]'); label='vlabel'
    return label

def render_single(config,preset,a_path,a_info,out,workdir,font_path):
    a=config['videoA']; start,_,dur=clip(a,a_info['duration']); cmd=['ffmpeg','-y','-hide_banner','-loglevel','warning','-ss',f'{start:.6f}','-i',str(a_path)]
    filters=[f"[0:v]trim=duration={dur:.6f},setpts=PTS-STARTPTS,{tf(W,H,a.get('single'))}[vbase]"]; final=overlay(cmd,filters,'vbase',preset,config.get('headline'),workdir,font_path,1)
    cmd+=['-filter_complex',';'.join(filters),'-map',f'[{final}]']
    if a_info['has_audio']: cmd+=['-map','0:a?','-c:a','aac','-b:a','192k']
    else: cmd+=['-an']
    cmd+=['-t',f'{dur:.6f}','-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart','-r',str(FPS),str(out)]; run(cmd)

def audio(filters,mode,audio_a,audio_b,split,total,rest):
    if mode=='b' and audio_b: filters.append(f'[1:a]atrim=duration={total:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]'); return 'aout'
    if mode=='mix' and audio_a and audio_b:
        filters += [f'[0:a]atrim=duration={split:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aa]',f'[1:a]atrim=duration={split:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bb]','[aa][bb]amix=inputs=2:duration=shortest:dropout_transition=0[mix0]']
        if rest>.02: filters += [f'[1:a]atrim=start={split:.6f}:duration={rest:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[brest]','[mix0][brest]concat=n=2:v=0:a=1[aout]']
        else: filters.append('[mix0]anull[aout]')
        return 'aout'
    if audio_a:
        filters.append(f'[0:a]atrim=duration={split:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aa]')
        if rest>.02: filters += [f'anullsrc=r=48000:cl=stereo,atrim=duration={rest:.6f}[sil]','[aa][sil]concat=n=2:v=0:a=1[aout]']
        else: filters.append('[aa]anull[aout]')
        return 'aout'
    if audio_b: filters.append(f'[1:a]atrim=duration={total:.6f},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[aout]'); return 'aout'
    return None

def render_split(config,preset,a_path,b_path,a_info,b_info,out,workdir,font_path):
    a,b=config['videoA'],config['videoB']; a_start,_,a_dur=clip(a,a_info['duration']); b_start,_,b_dur=clip(b,b_info['duration']); split=min(a_dur,b_dur); rest=max(0,b_dur-split)
    cmd=['ffmpeg','-y','-hide_banner','-loglevel','warning','-ss',f'{a_start:.6f}','-i',str(a_path),'-ss',f'{b_start:.6f}','-i',str(b_path)]
    filters=[f"[0:v]trim=duration={split:.6f},setpts=PTS-STARTPTS,{tf(W,H//2,a.get('split'))}[va]",f"[1:v]trim=duration={split:.6f},setpts=PTS-STARTPTS,{tf(W,H//2,b.get('split'))}[vb]",'[va][vb]vstack=inputs=2[split]']
    if rest>.02: filters += [f"[1:v]trim=start={split:.6f}:duration={rest:.6f},setpts=PTS-STARTPTS,{tf(W,H,b.get('full'))}[bfull]",'[split][bfull]concat=n=2:v=1:a=0[vbase]']
    else: filters.append('[split]null[vbase]')
    alabel=audio(filters,config.get('audioMode') or 'b',a_info['has_audio'],b_info['has_audio'],split,b_dur,rest); final=overlay(cmd,filters,'vbase',preset,config.get('headline'),workdir,font_path,2)
    cmd+=['-filter_complex',';'.join(filters),'-map',f'[{final}]']
    if alabel: cmd+=['-map',f'[{alabel}]','-c:a','aac','-b:a','192k']
    else: cmd+=['-an']
    cmd+=['-t',f'{b_dur:.6f}','-c:v','libx264','-preset','veryfast','-crf','19','-pix_fmt','yuv420p','-movflags','+faststart','-r',str(FPS),str(out)]; run(cmd)

def render_job(job_id,config):
    presets=[p for p in config.get('outputs',[]) if p in ('clean','label','winline')]; results=[]
    with tempfile.TemporaryDirectory(prefix='render-') as td:
        td=Path(td); a=td/'a.mp4'; download(config['videoA']['key'],a); ai=probe(a); b=None; bi=None
        if config.get('layout')=='split-full': b=td/'b.mp4'; download(config['videoB']['key'],b); bi=probe(b)
        fp=font(td)
        for preset in presets:
            out=td/f'{preset}.mp4'
            if b is None: render_single(config,preset,a,ai,out,td,fp)
            else: render_split(config,preset,a,b,ai,bi,out,td,fp)
            key=f'renders/{job_id}/{preset}.mp4'; upload(key,out); results.append({'preset':preset,'key':key})
    return results

class Handler(BaseHTTPRequestHandler):
    def log_message(self,fmt,*args): print(fmt%args,flush=True)
    def reply(self,status,data):
        raw=json.dumps(data,ensure_ascii=False).encode(); self.send_response(status); self.send_header('content-type','application/json; charset=utf-8'); self.send_header('content-length',str(len(raw))); self.end_headers(); self.wfile.write(raw)
    def do_GET(self): self.reply(200,{'ok':True}) if self.path=='/health' else self.reply(404,{'error':'not found'})
    def do_POST(self):
        if self.path!='/render': return self.reply(404,{'error':'not found'})
        try:
            n=int(self.headers.get('content-length') or 0); p=json.loads(self.rfile.read(n) or b'{}'); self.reply(200,{'ok':True,'outputs':render_job(p['jobId'],p['config'])})
        except Exception as e: traceback.print_exc(); self.reply(500,{'error':str(e)})

if __name__=='__main__': ThreadingHTTPServer(('0.0.0.0',PORT),Handler).serve_forever()
