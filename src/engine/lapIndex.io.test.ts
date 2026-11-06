import {expect,it} from 'vitest';
import {reconcileFolder} from './lapIndex';
it('retries a first .bon4 scan after transient IO failure instead of caching an empty run',async()=>{
 const file={path:'course/run.bon4',size:123,mtimeMs:456,local:true};
 const course={name:'course',controlLine:{name:'gate',latA:35,lonA:140,latB:35.01,lonB:140.01},sectors:[]};
 let computes=0;const compute=()=>{computes++;return {startMs:1,laps:[{n:1,time:30,startMs:1,sectors:[],topSpeed:100}]};};
 const failed=await reconcileFolder('course',[file],course,null,async()=>{throw Error('temporary IO');},compute);
 expect(failed.index.files['run.bon4']).toBeUndefined();expect(computes).toBe(0);
 const recovered=await reconcileFolder('course',[file],course,failed.index,async()=>new Uint8Array(1),compute);
 expect(recovered.index.files['run.bon4'].laps).toHaveLength(1);expect(computes).toBe(1);
});
