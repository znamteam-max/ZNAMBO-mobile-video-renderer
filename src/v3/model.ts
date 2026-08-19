export type Layout='single'|'split-full';
export type Slot='A'|'B';
export type Transform={zoom:number;panX:number;panY:number};
export type Position={x:number;y:number};
export type Clip={file:File|null;url:string;key:string;duration:number;trimStart:number;trimEnd:number;single:Transform;split:Transform;full:Transform};
export type SponsorType='none'|'winline'|'difference';
export type Output='clean'|'plate'|'sponsor'|'combined';
export type Plate={enabled:boolean;text:string;position:Position;backgroundColor:string;borderColor:string;borderEnabled:boolean;textColor:string;wordColors:Record<number,string>;fontSize:number;maxWidth:number;radius:number;paddingX:number;paddingY:number;lineGap:number;align:'left'|'center'|'right'};
export type ProjectLogo={enabled:boolean;mode:'linked'|'free';position:Position;scale:number;gap:number};
export const T:Transform={zoom:1,panX:0,panY:0};
export const blank=():Clip=>({file:null,url:'',key:'',duration:0,trimStart:0,trimEnd:0,single:{...T},split:{...T},full:{...T}});
export const clamp=(v:number,a:number,b:number)=>Math.max(a,Math.min(b,v));
export const uid=()=>crypto.randomUUID();
export const sponsorDefaults={winline:{x:740/1080,y:336/1920},difference:{x:626/1080,y:336/1920}};
export const fmt=(v:number)=>Number.isFinite(v)?v.toFixed(2):'0.00';
export async function readDuration(file:File){return await new Promise<number>((res,rej)=>{const u=URL.createObjectURL(file),v=document.createElement('video');v.preload='metadata';v.onloadedmetadata=()=>{const d=v.duration;URL.revokeObjectURL(u);res(Number.isFinite(d)?d:0)};v.onerror=()=>rej(new Error('Не удалось прочитать видео'));v.src=u})}
export async function upload(file:File,key:string,progress:(n:number)=>void){const c=await fetch('/api/upload/create',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,contentType:file.type||'video/mp4'})});if(!c.ok)throw new Error(await c.text());const {uploadId}=await c.json();const size=8*1024*1024,count=Math.ceil(file.size/size),parts=[];for(let i=0;i<count;i++){const r=await fetch(`/api/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&partNumber=${i+1}`,{method:'PUT',body:file.slice(i*size,Math.min((i+1)*size,file.size))});if(!r.ok)throw new Error(await r.text());parts.push(await r.json());progress((i+1)/count)}const x=await fetch('/api/upload/complete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({key,uploadId,parts})});if(!x.ok)throw new Error(await x.text())}
