import {expect,it,vi} from 'vitest';
import fs from 'node:fs';
import {parseLogBuffer as parseCore} from '../../engine/logLoader';
import {parseLogBuffer as parseWeb} from '../../services/logLoader';
import {setGFilterLevel} from '../../services/physics';
import * as physics from '../../engine/physics';
it('passes each host preference into one physics calculation, before any NMEA split',async()=>{
 const bytes=fs.readFileSync(new URL('../../../public/demo/sodegaura_20260815.nmea',import.meta.url));
 const buffer=Uint8Array.from(bytes).buffer;
 const spy=vi.spyOn(physics,'calculatePhysics');
 try{
  for(const level of ['weak','standard','strong'] as const){
   setGFilterLevel(level);const expected=await parseCore('demo.nmea',buffer,undefined,[],level);spy.mockClear();
   const actual=await parseWeb('demo.nmea',buffer,(_ja,en)=>en);
   expect(spy).toHaveBeenCalledTimes(1);expect(spy.mock.calls[0][1]).toBe(level);
   expect(actual.parts.map(p=>p.points.map(point=>[point.accelG,point.corneringG,point.turningRadius]))).toEqual(expected.parts.map(p=>p.points.map(point=>[point.accelG,point.corneringG,point.turningRadius])));
  }
 }finally{spy.mockRestore();setGFilterLevel('strong');}
});
