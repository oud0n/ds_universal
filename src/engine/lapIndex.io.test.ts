import {expect,it} from 'vitest';
import {reconcileFolder,courseHash,lapRows,SPLIT_RULE,type LapIndex} from './lapIndex';
it('retries a first .bon4 scan after transient IO failure instead of caching an empty run',async()=>{
 const file={path:'course/run.bon4',size:123,mtimeMs:456,local:true};
 const course={name:'course',controlLine:{name:'gate',latA:35,lonA:140,latB:35.01,lonB:140.01},sectors:[]};
 let computes=0;const compute=()=>{computes++;return {startMs:1,laps:[{n:1,time:30,startMs:1,sectors:[],topSpeed:100}]};};
 const failed=await reconcileFolder('course',[file],course,null,async()=>{throw Error('temporary IO');},compute);
 expect(failed.index.files['run.bon4']).toBeUndefined();expect(computes).toBe(0);
 const recovered=await reconcileFolder('course',[file],course,failed.index,async()=>new Uint8Array(1),compute);
 expect(recovered.index.files['run.bon4'].laps).toHaveLength(1);expect(computes).toBe(1);
});
it.each(['read','compute'] as const)('does not certify old-course laps after %s failure, and retries identical attributes',async failure=>{
 const file={path:'course/run.nmea',size:123,mtimeMs:456,local:true};
 const course={name:'course',controlLine:{name:'gate',latA:35,lonA:140,latB:35.01,lonB:140.01},sectors:[]};
 const oldCourse={...course,controlLine:{...course.controlLine,latA:34}};
 const hidden={file:'run.nmea',n:1,startMs:1000};
 const previous:LapIndex={version:1,courseHash:courseHash(oldCourse),courseName:'old',hidden:[hidden],files:{'run.nmea':{size:123,mtimeMs:456,split:SPLIT_RULE,startMs:1,laps:[{n:1,time:90,startMs:1000,sectors:[],topSpeed:100}],videos:['clip.mp4']}}};
 const read=async()=>{if(failure==='read')throw Error('temporary read');return new Uint8Array(1);};
 const compute=()=>{throw Error('temporary parse');};
 let failed=await reconcileFolder('course',[file],course,previous,read,compute);
 expect(failed.index.files['run.nmea'].needsRecompute).toBe(true);expect(lapRows('course',failed.index)).toEqual([]);expect(failed.index.hidden).toEqual([hidden]);
 // 新しいハッシュで保存した後も、再度の失敗で非表示の印を捨てない。
 failed=await reconcileFolder('course',[file],course,JSON.parse(JSON.stringify(failed.index)),read,compute);
 expect(failed.index.hidden).toEqual([hidden]);let reads=0;
 const recovered=await reconcileFolder('course',[file],course,failed.index,async()=>{reads++;return new Uint8Array(1);},()=>({startMs:1,laps:[{n:2,time:30,startMs:1001,sectors:[],topSpeed:100}]}));
 expect(reads).toBe(1);expect(recovered.index.files['run.nmea'].needsRecompute).toBeUndefined();expect(recovered.index.files['run.nmea'].videos).toEqual(['clip.mp4']);expect(recovered.index.hidden).toEqual([{...hidden,n:2,startMs:1001}]);expect(lapRows('course',recovered.index)[0].time).toBe(30);
});
