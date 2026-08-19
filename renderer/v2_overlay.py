from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import server

W,H,FPS=server.W,server.H,server.FPS
ORANGE=server.ORANGE
clamp=server.clamp
rgba=server.rgba
word_color=server.word_color


def plate_image(config, workdir, font_path):
    cfg=config or {}; text=str(cfg.get('text') or '').strip().upper()
    if not text: return None
    font_size=int(clamp(float(cfg.get('fontSize') or 52),24,150)); max_width=int(clamp(float(cfg.get('maxWidth') or 860),220,1040))
    padding_x=int(clamp(float(cfg.get('paddingX') if cfg.get('paddingX') is not None else 24),0,160)); padding_y=int(clamp(float(cfg.get('paddingY') if cfg.get('paddingY') is not None else 12),0,120))
    line_gap=int(clamp(float(cfg.get('lineGap') if cfg.get('lineGap') is not None else 4),-20,80)); align=str(cfg.get('align') or 'left')
    if align not in ('left','center','right'): align='left'
    radius=int(clamp(float(cfg.get('radius') or 18),0,80)); bg=rgba(cfg.get('backgroundColor'),(17,17,17,255)); border=rgba(cfg.get('borderColor'),ORANGE); base=rgba(cfg.get('textColor'),(255,255,255,255)); enabled=bool(cfg.get('borderEnabled',True)); colors=cfg.get('wordColors') or {}
    fnt=ImageFont.truetype(font_path,font_size); measure=Image.new('RGBA',(max_width,2400),(0,0,0,0)); md=ImageDraw.Draw(measure); space=md.textlength(' ',font=fnt); limit=max(40,max_width-2*padding_x); line_height=max(1,int(font_size*1.02+line_gap))
    lines=[]; wi=0
    for raw in text.split('\n'):
        words=raw.split()
        if not words: lines.append([]); continue
        current=[]; width=0.0
        for word in words:
            ww=md.textlength(word,font=fnt); need=ww if not current else space+ww
            if current and width+need>limit: lines.append(current); current=[]; width=0.0; need=ww
            current.append((word,wi,ww)); wi+=1; width+=need
        lines.append(current)
    widths=[]
    for line in lines:
        widths.append(sum(ww for _,_,ww in line)+space*max(0,len(line)-1))
    content_w=int(max(widths or [0])); image_w=min(max_width,max(40,content_w+2*padding_x)); image_h=max(30,len(lines)*line_height+2*padding_y)
    image=Image.new('RGBA',(image_w,image_h),(0,0,0,0)); draw=ImageDraw.Draw(image); draw.rounded_rectangle((1,1,image_w-2,image_h-2),radius=radius,fill=bg,outline=border if enabled else None,width=4 if enabled else 0)
    y=padding_y-int(font_size*.08)
    for line,lw in zip(lines,widths):
        if align=='center': x=(image_w-lw)/2
        elif align=='right': x=image_w-padding_x-lw
        else: x=padding_x
        for i,(word,idx,ww) in enumerate(line):
            if i:x+=space
            draw.text((x,y),word,font=fnt,fill=word_color(colors,idx,base)); x+=ww
        y+=line_height
    path=Path(workdir)/'plate-v2.png'; image.save(path); x=int(clamp(float(cfg.get('x',.08)),0,.95)*W); y=int(clamp(float(cfg.get('y',.10)),0,.95)*H)
    return str(path),x,y


def project_logo_image(config, workdir, font_path):
    cfg=config or {}
    if not cfg.get('enabled'): return None
    scale=clamp(float(cfg.get('scale') or 1),.4,2.5); size=max(50,int(180*scale))
    im=Image.new('RGBA',(size,size),(0,0,0,0)); d=ImageDraw.Draw(im); pad=max(2,int(size*.025)); d.ellipse((pad,pad,size-pad,size-pad),fill=(243,107,34,255),outline=(238,238,238,255),width=max(2,int(size*.025)))
    try: fnt=ImageFont.truetype(font_path,max(12,int(size*.20)))
    except Exception: fnt=ImageFont.load_default()
    for text,yy in [('ВЕСЬ',.34),('СПОРТ',.53)]:
        box=d.textbbox((0,0),text,font=fnt); tw=box[2]-box[0]; d.text(((size-tw)/2,size*yy),text,font=fnt,fill='white')
    d.arc((size*.18,size*.12,size*.86,size*.54),200,340,fill=(255,190,145,255),width=max(2,int(size*.025)))
    path=Path(workdir)/'ves-sport.png'; im.save(path); x=int(clamp(float(cfg.get('x',.03)),0,.95)*W); y=int(clamp(float(cfg.get('y',.10)),0,.95)*H)
    return str(path),x,y


def overlay_layers(cmd,filters,label,preset,config,workdir,font_path,index):
    preset={'label':'plate','winline':'sponsor'}.get(preset,preset); include_plate=preset in ('plate','combined'); include_sponsor=preset in ('sponsor','combined')
    plate_cfg=config.get('plate') or {}; project_cfg=config.get('projectLogo') or {}; plate_result=None
    if include_plate and plate_cfg.get('enabled',True): plate_result=plate_image(plate_cfg,workdir,font_path)
    if plate_result:
        ppath,px,py=plate_result; pimg=Image.open(ppath); linked=bool(project_cfg.get('enabled')) and str(project_cfg.get('mode') or 'linked')=='linked'; logo_result=project_logo_image(project_cfg,workdir,font_path) if linked else None
        if logo_result:
            lpath,_,_=logo_result; limg=Image.open(lpath); gap=int(clamp(float(project_cfg.get('gap') or 16),0,160)); gx=px; gy=py+max(0,(pimg.height-limg.height)//2); px=px+limg.width+gap
            cmd += ['-loop','1','-framerate',str(FPS),'-i',lpath]; nxt=f'vproject{index}'; filters.append(f'[{label}][{index}:v]overlay={gx}:{gy}:eof_action=repeat:shortest=0[{nxt}]'); label=nxt; index+=1
        cmd += ['-loop','1','-framerate',str(FPS),'-i',ppath]; nxt=f'vplate{index}'; filters.append(f'[{label}][{index}:v]overlay={px}:{py}:eof_action=repeat:shortest=0[{nxt}]'); label=nxt; index+=1
    if include_plate and project_cfg.get('enabled') and str(project_cfg.get('mode') or 'linked')=='free':
        result=project_logo_image(project_cfg,workdir,font_path)
        if result:
            path,x,y=result; cmd += ['-loop','1','-framerate',str(FPS),'-i',path]; nxt=f'vproject{index}'; filters.append(f'[{label}][{index}:v]overlay={x}:{y}:eof_action=repeat:shortest=0[{nxt}]'); label=nxt; index+=1
    if include_sponsor:
        result=server.sponsor_image(config.get('sponsor'),workdir,font_path)
        if result:
            path,x,y=result; cmd += ['-loop','1','-framerate',str(FPS),'-i',path]; nxt=f'vsponsor{index}'; filters.append(f'[{label}][{index}:v]overlay={x}:{y}:eof_action=repeat:shortest=0[{nxt}]'); label=nxt; index+=1
    return label


def install():
    server.plate_image=plate_image
    server.overlay_layers=overlay_layers
    return server
