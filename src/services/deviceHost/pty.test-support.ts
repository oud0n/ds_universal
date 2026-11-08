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
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk).slice(0, 2048); });
  child.on('error', error => ready.reject(error));
  child.on('close', () => ready.reject(new Error('PTY helper closed: ' + stderr)));
  lines.on('line', line => {
    try {
      const value = JSON.parse(line);
      if (value.port) ready.resolve(value.port);
      if (value.bytes) peer.receive(Uint8Array.from(value.bytes));
      if (value.unplugged) unplugged.resolve();
    } catch (error) { ready.reject(error); child.kill(); }
  });
  const port = await ready.promise;
  return {
    peer, port,
    async unplug() { child.stdin.write('{"unplug":true}\n'); await unplugged.promise; },
    async stop() {
      const closed = once(child, 'close');
      child.stdin.end();
      const timeout = setTimeout(() => child.kill('SIGKILL'), 1000);
      await closed; clearTimeout(timeout); lines.close();
    }
  };
}
