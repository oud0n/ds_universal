import {expect,it} from 'vitest';
import {groupLocalVideoFiles} from './videoChapterManager';
import {blobByteSource,parseGoproGps} from './gpmfParser';
import type {BinaryFile} from './ports';

const bytes=(text:string)=>new TextEncoder().encode(text);
const join=(...parts:Uint8Array[])=>{const out=new Uint8Array(parts.reduce((n,p)=>n+p.length,0));let offset=0;for(const part of parts){out.set(part,offset);offset+=part.length;}return out;};
const words=(...values:number[])=>{const out=new Uint8Array(values.length*4),view=new DataView(out.buffer);values.forEach((n,i)=>view.setUint32(i*4,n));return out;};
const box=(name:string,...body:Uint8Array[])=>{const data=join(...body);return join(words(data.length+8),bytes(name),data);};

// 二つの独立したGPS軌跡。実動画・個人ログを使わず、MP4のgpmdサンプルを構成する。
function movie(lat:number,day:number,count:number):BinaryFile{
 const payload=new Uint8Array(8+72*count),v=new DataView(payload.buffer);
 payload.set(bytes('GPS9'));v.setUint8(4,'d'.charCodeAt(0));v.setUint8(5,72);v.setUint16(6,count);
 for(let r=0;r<count;r++)[lat+r*0.0001,140,1,10,10,day,r,1,3].forEach((value,i)=>v.setFloat64(8+r*72+i*8,value));
 const moov=(offset:number)=>box('moov',box('trak',box('mdia',box('hdlr',words(0,0),bytes('meta')),box('mdhd',words(0,0,0,1000)),box('minf',box('stbl',box('stsd',words(0,1,8),bytes('gpmd')),box('stsz',words(0,payload.length,1)),box('stts',words(0,1,1,count*1000)),box('stco',words(0,1,offset)))))));
 const header=moov(0),data=join(moov(header.length+8),box('mdat',payload));
 return {name:'GX010017.MP4',size:data.length,lastModified:day*86400000,arrayBuffer:async()=>data.slice().buffer,slice:(a=0,b=data.length)=>({arrayBuffer:async()=>data.slice(a,b).buffer})};
}

it('plans independent GPS imports for duplicate local recording numbers',async()=>{
 const files=[movie(35,9000,3),movie(36,9001,4)];
 const groups=await groupLocalVideoFiles(files,async file=>({fileName:file.name,fileSize:file.size,durationSec:4,creationTime:null,timescale:1000}));
 const logs=await Promise.all(groups.map(group=>parseGoproGps(group.map(blobByteSource))));
 expect(logs).toHaveLength(2);expect(logs.map(log=>log.points.length)).toEqual([3,4]);
 expect(logs[0].points.every(p=>p.latitude<35.1)).toBe(true);expect(logs[1].points.every(p=>p.latitude>35.9)).toBe(true);
 expect(logs[0].points[0].timestamp).not.toBe(logs[1].points[0].timestamp);
});
