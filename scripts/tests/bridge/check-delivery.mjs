import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

// ネイティブが作って実行待ちになった実際の式を、現行版と旧版の画面で実行する。
const scripts = JSON.parse(readFileSync(process.argv[2], 'utf8'));
assert.equal(scripts.length, 5);
function deliver(receiver) {
  const window = { dsNative: { sessionReplies: true, receive() { assert.fail('old document received a reply'); } } };
  const context = createContext({ window });
  window.dsNative = receiver;
  for (const script of scripts) runInContext(script, context);
}

const current = [];
deliver({ sessionReplies: true, receive: json => current.push(JSON.parse(json)) });
const [success, failure, bootstrap, event, own] = current;
assert.equal(current.length, 5);
assert.equal(success.id, 1);
assert.equal(success.ok, true);
assert.deepEqual(success.result, { from: 'modern' });
assert.equal(failure.id, 1);
assert.equal(failure.error.message, 'queued error');
assert.equal(bootstrap.id, 0);
const sessions = [success.session, failure.session, bootstrap.session];
assert(sessions.every(session => typeof session === 'string'));
assert.equal(new Set(sessions).size, 3);
assert.deepEqual(event, { event: 'system.appState', data: { state: 'active' } });
assert.deepEqual(own, { id: 1, ok: true, result: { from: 'legacy' } });

const legacy = [];
let settled;
deliver({ receive(json) {
  const message = JSON.parse(json);
  legacy.push(message);
  // 公開済みの画面は id だけで対応する要求を一度だけ完了させる。
  if (message.id === 1 && settled === undefined) settled = message;
} });
assert.deepEqual(legacy, [event, own]);
assert.deepEqual(settled, own);
console.log('PASS queued native JavaScript delivered to current and legacy documents');
