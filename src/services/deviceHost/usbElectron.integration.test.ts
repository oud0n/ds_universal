import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';
import { ptyPeer } from './pty.test-support';
const executable = process.env.LAPLOUPE_USB_TEST_BINARY;
const enabled = !!executable && process.platform !== 'win32';

describe.skipIf(!enabled)('Electron preload/IPC＋Rust＋OS疑似シリアル', () => {
  it('Web Serialなしで設定/取得を完了し、開いたまま画面を再読込みしても再接続できる', async () => {
    const pty = await ptyPeer(64), folder = await mkdtemp(join(tmpdir(), 'laploupe-usb-proof-'));
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const built = await build({ configFile:false, logLevel:'error', define:{'process.env.NODE_ENV':JSON.stringify('production')}, build:{ write:false, minify:false,
        lib:{entry:resolve('scripts/usb-host/renderer.ts'),formats:['iife'],name:'UsbHostProof'}, sourcemap:false } });
      const output = Array.isArray(built) ? built[0] : built;
      if (!('output' in output)) throw new Error('Unexpected Vite build result');
      const code = output.output.filter(item => item.type === 'chunk').map(item => item.code).join('\n');
      const html = join(folder,'proof.html'), result = join(folder,'result.json'), userData=join(folder,'user-data');
      await mkdir(userData);
      await writeFile(html,'<!doctype html><meta charset="utf-8"><script>'+code.replace(/<\/script/gi,'<\\/script')+'</script>');
      const electron = createRequire(import.meta.url)('electron');
      child = spawn(electron,[resolve('scripts/usb-host/electron-proof.cjs')],{env:{...process.env,
        ELECTRON_RUN_AS_NODE:undefined, USB_PROOF_PORT:pty.port, USB_PROOF_HTML:html,
        USB_PROOF_RESULT:result,USB_PROOF_USER_DATA:userData},stdio:['ignore','ignore','pipe']});
      let stderr=''; child.stderr?.on('data', chunk => { stderr += String(chunk).slice(0,4096); });
      const exited=once(child,'close');
      const timeout=setTimeout(()=>child?.kill('SIGKILL'),30000);
      try { await exited; } finally { clearTimeout(timeout); }
      let data;
      try { data=JSON.parse(await readFile(result,'utf8')); } catch { throw new Error('Electron proof did not report: '+stderr); }
      expect(data.error).toBeUndefined(); expect(data.oldChildEnded).toBe(true);
      expect(data.afterReload).toEqual(data.first);
      expect(data.afterCancelledNavigation).toEqual(data.first.config); expect(data.afterCancelledReload).toEqual(data.first.config);
      expect(data.cancelledQuitKeptConnection).toBe(true); expect(data.afterCancelledQuit).toEqual(data.first);
      expect(data.first.buffer).toEqual(Array.from(pty.peer.image));
      expect(data.first.config).toMatchObject({model:'DS4',samplingRateHz:20,autoLogSpeedKmh:30});
      expect(pty.peer.commands).toHaveLength(67);
    } finally { child?.kill('SIGKILL'); await pty.stop(); await rm(folder,{recursive:true,force:true}); }
  },40000);
});
