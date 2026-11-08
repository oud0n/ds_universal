// 異常な子プロセスを再現する試験用。実USBは扱わない。
const readline = require('node:readline');
const mode = process.argv[2];
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'oversize') process.stdout.write('x'.repeat(512 * 1024 + 1));
else send({ type: 'ready', version: mode === 'version' ? 2 : 1 });
readline.createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (mode === 'block') return;
  if (method === 'serial.open') {
    send({ type: 'response', id, result: null });
    if (mode === 'foreign') send({ type: 'event', event: { type: 'serial.data', session: 'foreign', bytes: [1] } });
  } else if (method === 'serial.write') {
    if (mode === 'exit') process.exit(42);
    send({ type: 'response', id, result: { written: mode === 'invalid-write' ? 999 : Math.min(2, params.bytes.length) } });
    if (mode !== 'invalid-write') send({ type: 'event', event: { type: 'serial.data', session: params.session, bytes: params.bytes.slice(0,2) } });
  } else send({ type: 'response', id, result: null });
});
