import {expect,it} from 'vitest';
import fs from 'node:fs';
import {parseLogBuffer} from '../../engine/logLoader';
import {applyGFilter} from '../../engine/physics';
import type {Session} from '../../types/telemetry';
import {noteParsedPhysics,refreshParsedPhysics} from './parsedPhysics';

it('reconciles detached prepared logs without changing shared cached points or saved lap metadata',async()=>{
 const bytes=fs.readFileSync(new URL('../../../public/demo/sodegaura_20260815.nmea',import.meta.url));
 const parsed=await parseLogBuffer('demo.nmea',Uint8Array.from(bytes).buffer,undefined,[],'strong');
 const points=parsed.parts[0].points,original=points.map(p=>[p.accelG,p.corneringG]),laps=[{lapNumber:3,hidden:true}];
 const prepared={id:'prepared',points,laps,clockOffsetSec:7,sourceFile:{part:2}} as unknown as Session;
 noteParsedPhysics(points,'strong');
 await Promise.resolve();
 const first=refreshParsedPhysics([prepared],'weak')[0];
 const expected=applyGFilter(points.map(p=>({...p})),'weak');
 expect(expected.map(p=>[p.accelG,p.corneringG])).not.toEqual(original);
 expect(first.points).toEqual(expected);expect(first.laps).toBe(laps);expect(first.clockOffsetSec).toBe(7);expect(first.sourceFile).toBe(prepared.sourceFile);
 expect(points.map(p=>[p.accelG,p.corneringG])).toEqual(original);
 expect(refreshParsedPhysics([first],'weak')[0]).toBe(first);
 // 別の待機中の利用者は同じ準備結果から、その時点の設定で採用する。
 expect(refreshParsedPhysics([prepared],'strong')[0]).toBe(prepared);
});
