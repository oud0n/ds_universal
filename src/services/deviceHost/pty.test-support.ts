import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { SerialPeer, deferred } from './fixtures.test-support';

export async function ptyPeer(fragment = 64, mode: SerialPeer['mode'] = 'normal') {
  const child = spawn('python3', [resolve('scripts/usb-host/pty.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  const ready = deferred<string>(), unplugged = deferred();
  const peer = new SerialPeer(bytes => { child.stdin.write(JSON.stringify({ bytes: Array.from(bytes) }) + '\n'); }, fragment);
  peer.mode = mode;
  const lines = createInterface({ input: child.stdout });
  let stderr = '', failure: unknown, unplugging = false;
  child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2048); });
  child.on('error', error => { failure=error; ready.reject(error); if(unplugging)unplugged.reject(error); });
  child.on('close', () => { const error=new Error('PTY helper closed: '+stderr); failure ??=error; ready.reject(error); if(unplugging)unplugged.reject(error); });
  lines.on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.port) ready.resolve(value.port);
      if (value.bytes) peer.receive(Uint8Array.from(value.bytes));
      if (value.unplugged) { unplugging=false; unplugged.resolve(); }
    } catch (error) { failure=error; ready.reject(error); if(unplugging)unplugged.reject(error); child.kill(); }
  });
  const port = await ready.promise;
  return {
    peer, port,
    async unplug() { if(failure)throw failure; unplugging=true; child.stdin.write('{"unplug":true}\n'); await unplugged.promise; },
    async stop() {
      if(child.exitCode!==null||child.signalCode!==null){lines.close();return;}
      const closed = once(child, 'close');
      child.stdin.end();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 1000);
      await closed; clearTimeout(timeout); lines.close();
    }
  };
}
