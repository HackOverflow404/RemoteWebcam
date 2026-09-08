import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSessionStats } from '../src/lib/webrtcSessionStats.ts';

test('averages, lifecycle counts, missing metrics, and late polls', async (t) => {
  const logs = [];
  let poll;
  t.mock.method(console, 'log', (prefix, value) => {
    if (prefix === '[webrtc-session]') logs.push(JSON.parse(value));
  });
  t.mock.method(globalThis, 'setInterval', (callback) => { poll = callback; return 1; });
  const clear = t.mock.method(globalThis, 'clearInterval', () => {});
  let report = new Map([
    ['a', { type: 'remote-inbound-rtp', roundTripTime: 0.1, jitter: 0.01 }],
    ['b', { type: 'remote-inbound-rtp', roundTripTime: 0.3, jitter: 0.03 }],
    ['c', { type: 'inbound-rtp', roundTripTime: 99, jitter: 99 }],
  ]);
  const session = startSessionStats({ getStats: async () => report });
  await Promise.resolve();
  assert.equal(logs.at(-1).averageRttMs, 200);
  assert.equal(logs.at(-1).averageJitterMs, 20);
  session.markConnected();
  session.markConnected();
  report = new Map([['a', { type: 'remote-inbound-rtp', roundTripTime: 0, jitter: NaN }]]);
  poll();
  await Promise.resolve();
  session.stop('user stop');
  session.stop();
  assert.equal(logs.at(-1).rttSamples, 3);
  assert.equal(logs.at(-1).jitterSamples, 2);
  assert.equal(logs.at(-1).averageRttMs, 400 / 3);
  assert.deepEqual(logs.at(-1).counts, { started: 1, connected: 1, ended: 1, active: 0 });
  assert.equal(clear.mock.callCount(), 1);

  let resolve;
  const next = startSessionStats({ getStats: () => new Promise((r) => { resolve = r; }) });
  next.stop('unmount');
  const logCount = logs.length;
  resolve(report);
  await Promise.resolve();
  assert.equal(logs.length, logCount);
  assert.equal(logs.at(-1).averageRttMs, null);
  assert.equal(logs.at(-1).averageJitterMs, null);
  assert.deepEqual(logs.at(-1).counts, { started: 2, connected: 1, ended: 2, active: 0 });

  const failing = startSessionStats({ getStats: async () => { throw new Error('closed'); } });
  await Promise.resolve();
  assert.equal(logs.at(-1).event, 'stats-error');
  failing.stop();
  assert.equal(logs.at(-1).statsErrors, 1);
});

test('prevents overlapping polls and tracks simultaneous sessions independently', async (t) => {
  const logs = [];
  const polls = [];
  t.mock.method(console, 'log', (prefix, value) => {
    if (prefix === '[webrtc-session]') logs.push(JSON.parse(value));
  });
  t.mock.method(globalThis, 'setInterval', (callback) => {
    polls.push(callback);
    return polls.length;
  });
  t.mock.method(globalThis, 'clearInterval', () => {});
  let resolve;
  let calls = 0;
  const first = startSessionStats({ getStats: () => {
    calls++;
    return new Promise((done) => { resolve = done; });
  } });
  const baseline = logs.at(-1).counts;
  const second = startSessionStats({ getStats: async () => new Map() });
  await Promise.resolve();
  assert.equal(logs.at(-1).counts.active, baseline.active + 1);
  polls[0]();
  polls[0]();
  assert.equal(calls, 1);
  resolve(new Map([
    ['invalid', { type: 'remote-inbound-rtp', roundTripTime: -1, jitter: Infinity }],
    ['valid', { type: 'remote-inbound-rtp', roundTripTime: 0.05, jitter: 0 }],
  ]));
  await Promise.resolve();
  assert.equal(logs.at(-1).averageRttMs, 50);
  assert.equal(logs.at(-1).averageJitterMs, 0);
  assert.equal(logs.at(-1).rttSamples, 1);
  first.stop();
  const endedLogCount = logs.length;
  first.markConnected();
  polls[0]();
  assert.equal(logs.length, endedLogCount);
  assert.equal(calls, 1);
  second.stop();
  assert.equal(logs.at(-1).averageRttMs, null);
  assert.equal(logs.at(-1).counts.active, baseline.active - 1);
  assert.equal(logs.at(-1).counts.ended, baseline.ended + 2);
});
