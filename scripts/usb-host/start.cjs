const { spawn } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd:root,env,stdio:'inherit' });
    const stop = signal => child.kill(signal);
    const interrupt = () => stop('SIGINT'), terminate=()=>stop('SIGTERM');
    process.on('SIGINT',interrupt); process.on('SIGTERM',terminate);
    child.once('error',reject);
    child.once('close',(code,signal)=>{ process.removeListener('SIGINT',interrupt);process.removeListener('SIGTERM',terminate);
      code===0?resolve():reject(new Error(`${command} failed (${signal||code})`)); });
  });
}
(async()=>{
  await run('cargo',['build','--manifest-path','native-usb/Cargo.toml','--locked']);
  if (!process.env.npm_execpath) throw new Error('Run with npm run start:usb');
  await run(process.execPath,[process.env.npm_execpath,'start'],{...process.env,LAPLOUPE_USB_HOST:'1'});
})().catch(error=>{console.error(error.message);process.exitCode=1;});
