import {describe,expect,it} from 'vitest';
import {decodeUtf8,decodeWindows1252,inflateZlib} from './codecs';
import {zlibSync} from 'fflate';
describe('portable codecs',()=>{
 it('decodes UTF-8, BOM, surrogate and truncated sequences as the existing Web decoder',()=>{
  const examples=[[0xef,0xbb,0xbf,65],[0xe6,0x97,0xa5,0xf0,0x9f,0x8f,0x8e],[0xc0,0xaf],[0xed,0xa0,0x80],[0xe2,0x82],[0xe0,0x80,0x80],[0xf4,0x90,0x80,0x80],[0xe2,65,66]];
  let seed=9231;
  for(let i=0;i<1000;i++){const bytes:number[]=[];for(let j=0;j<23;j++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;bytes.push(seed&255);}examples.push(bytes);}
  for(const input of examples){const bytes=Uint8Array.from(input);expect(decodeUtf8(bytes)).toBe(new TextDecoder().decode(bytes));}
 });
 it('preserves Windows-1252 byte mappings',()=>{
  const bytes=Uint8Array.from({length:256},(_,i)=>i);
  expect(decodeWindows1252(bytes)).toBe(new TextDecoder('windows-1252').decode(bytes));
 });
 it('retains decompressed records when the compressed trailer is truncated',()=>{
  const bytes=new TextEncoder().encode('record '.repeat(10000));
  const compressed=zlibSync(bytes);
  expect(inflateZlib(compressed.subarray(0,compressed.length-4))).toEqual(bytes);
  const partial=inflateZlib(compressed.subarray(0,compressed.length-10));
  expect(partial.length).toBeGreaterThan(0);expect(partial).toEqual(bytes.subarray(0,partial.length));
 });
 it('inflates compressed records without a DecompressionStream',()=>{
  const bytes=new TextEncoder().encode('lap record '.repeat(8000));
  expect(inflateZlib(zlibSync(bytes))).toEqual(bytes);
 });
});
