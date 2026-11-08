const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root=path.resolve(__dirname,'../..');
function run(command,args,env=process.env) {
  const result=spawnSync(command,args,{cwd:root,env,stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status!==0) process.exit(result.status||1);
}
run('cargo',['test','--manifest-path','native-usb/Cargo.toml','--locked']);
run('cargo',['build','--manifest-path','native-usb/Cargo.toml','--locked','--features','test-port','--target-dir','native-usb/target/test-host']);
run(process.execPath,['--test','electron/usb-host.test.cjs','electron/usb-ipc.test.cjs']);
if (process.platform==='win32') {
  console.log('OS pseudo-serial and Electron integration tests require a POSIX host; Windows real I/O remains unverified.');
} else {
  const binary=path.join(root,'native-usb/target/test-host/debug/laploupe-usb-host');
  run(process.execPath,['node_modules/vitest/vitest.mjs','run',
    'src/services/deviceHost/usbHost.integration.test.ts','src/services/deviceHost/usbElectron.integration.test.ts'],
    {...process.env,LAPLOUPE_USB_TEST_BINARY:binary});
}
