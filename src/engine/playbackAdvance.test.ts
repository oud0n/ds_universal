import {expect,it} from 'vitest';
import {advancePlayback,comparisonTime} from './playbackAdvance';
import {asSessionSec} from './playbackPosition';
it('loops a time comparison even when its end equals the physical session end',()=>{
 const next=advancePlayback({current:asSessionSec(59.99),deltaSec:0.02,start:10,end:60,loop:true,master:null,movedOutside:false});expect(next.sessionSec).toBe(10);expect(next.looped).toBe(true);expect(next.stopped).toBe(false);
});
it('stops ordinary session playback at its end',()=>{expect(advancePlayback({current:asSessionSec(59.99),deltaSec:0.02,start:0,end:60,loop:false,master:null,movedOutside:false})).toMatchObject({sessionSec:60,stopped:true});});
it('holds a fast base at its lap end while a slower comparison is still running',()=>{
 expect(comparisonTime(10,40,45)).toEqual({sessionSec:40,hold:true});expect(comparisonTime(100,160,45)).toEqual({sessionSec:145,hold:false});
});
