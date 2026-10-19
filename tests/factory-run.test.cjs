'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { combinedExit } = require('../scripts/factory-run.cjs');
const { restrictBrowser } = require('../scripts/factory-offense.cjs');

test('factory aggregation never converts an interrupted worker into success', () => {
  const passed = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  const failed = spawnSync(process.execPath, ['-e', 'process.exit(1)']);
  const interrupted = spawnSync(process.execPath, ['-e', "process.kill(process.pid, 'SIGTERM')"]);
  assert.equal(interrupted.signal, 'SIGTERM');
  assert.equal(combinedExit(passed, passed), 0);
  assert.equal(combinedExit(passed, failed), 1);
  assert.equal(combinedExit(passed, interrupted), 2);
  assert.equal(combinedExit(interrupted, passed), 2);
  assert.equal(combinedExit(passed, { status: null, error: new Error('Worker unavailable') }), 2);
});

test('browser scope guards both HTTP requests and WebSockets before pages are created', async () => {
  let requestHandler, socketHandler;
  const context = {
    async route(pattern, handler) { assert.equal(pattern, '**/*'); requestHandler = handler; },
    async routeWebSocket(pattern, handler) { assert.equal(pattern, '**/*'); socketHandler = handler; }
  };
  const blocked = [];
  await restrictBrowser(context, new URL('http://127.0.0.1:8000/'), blocked);
  const route = url => ({ request: () => ({ url: () => url }), continue: () => 'allowed', abort: () => 'blocked' });
  assert.equal(requestHandler(route('http://127.0.0.1:8000/index.html')), 'allowed');
  assert.equal(requestHandler(route('http://127.0.0.1:9000/')), 'blocked');
  assert.equal(requestHandler(route('https://example.invalid/')), 'blocked');
  let closed = false;
  await socketHandler({ close: async options => { assert.equal(options.code, 1008); closed = true; } });
  assert.equal(closed, true);
  assert.deepEqual(blocked, ['http://127.0.0.1:9000', 'https://example.invalid', 'WebSocket blocked']);
});
