import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MissMemo, contractTag, createMemoryDataCache } from './contract-cache.ts';

/** A clock the test moves by hand, in milliseconds. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (seconds: number) => void (t += seconds * 1000) };
}

const spec = (compute: () => Promise<{ value: string; cache: boolean }>, over = {}) => ({
  key: ['k'],
  tags: ['t'],
  ttlSeconds: 60,
  compute,
  ...over,
});

test('contractTag names the contract', () => {
  assert.equal(contractTag('CABC'), 'contract:CABC');
});

// --- DataCache (memory implementation) --------------------------------------

test('a remembered value is served without computing again, until its lifetime ends', async () => {
  const c = clock();
  const cache = createMemoryDataCache(c.now);
  let runs = 0;
  const compute = async () => ({ value: `v${++runs}`, cache: true });

  assert.equal(await cache.remember(spec(compute)), 'v1');
  c.advance(59);
  assert.equal(await cache.remember(spec(compute)), 'v1');
  assert.equal(runs, 1);

  c.advance(2); // 61 s: past the 60 s lifetime
  assert.equal(await cache.remember(spec(compute)), 'v2');
  assert.equal(runs, 2);
});

test('a result that says cache: false is returned but never remembered', async () => {
  const cache = createMemoryDataCache(clock().now);
  let runs = 0;
  const compute = async () => ({ value: `v${++runs}`, cache: false });

  assert.equal(await cache.remember(spec(compute)), 'v1');
  assert.equal(await cache.remember(spec(compute)), 'v2');
  assert.equal(runs, 2);
});

test('different keys are different entries', async () => {
  const cache = createMemoryDataCache(clock().now);
  assert.equal(await cache.remember(spec(async () => ({ value: 'a', cache: true }), { key: ['a'] })), 'a');
  assert.equal(await cache.remember(spec(async () => ({ value: 'b', cache: true }), { key: ['b'] })), 'b');
  assert.equal(await cache.remember(spec(async () => ({ value: 'x', cache: true }), { key: ['a'] })), 'a');
});

test('clearing by tag drops only the entries carrying it', async () => {
  const cache = createMemoryDataCache(clock().now);
  let runs = 0;
  const mk = (key: string, tag: string) =>
    spec(async () => ({ value: `${key}${++runs}`, cache: true }), { key: [key], tags: [tag] });

  await cache.remember(mk('a', 'contract:A'));
  await cache.remember(mk('b', 'contract:B'));
  cache.clear('contract:A');

  assert.equal(await cache.remember(mk('b', 'contract:B')), 'b2', 'B is still remembered');
  assert.equal(await cache.remember(mk('a', 'contract:A')), 'a3', 'A was dropped and recomputed');
});

// --- MissMemo ------------------------------------------------------------------

test('a remembered miss lasts 30 seconds and not a moment longer', () => {
  const c = clock();
  const misses = new MissMemo(30, c.now);

  assert.equal(misses.has('k'), false);
  misses.remember('k');
  assert.equal(misses.has('k'), true);
  c.advance(29);
  assert.equal(misses.has('k'), true);
  c.advance(1); // exactly 30 s
  assert.equal(misses.has('k'), false, 'forgotten at the lifetime, not after it');
});

test('misses are per key, and clear forgets them all', () => {
  const misses = new MissMemo(30, clock().now);
  misses.remember('a');
  assert.equal(misses.has('a'), true);
  assert.equal(misses.has('b'), false);
  misses.clear();
  assert.equal(misses.has('a'), false);
});

test('the memo is bounded: past its cap the oldest entry makes room', () => {
  const misses = new MissMemo(30, clock().now);
  for (let i = 0; i < 1_000; i++) misses.remember(`k${i}`);
  misses.remember('newest');

  assert.equal(misses.has('newest'), true);
  assert.equal(misses.has('k0'), false, 'the oldest was evicted');
  assert.equal(misses.has('k999'), true, 'the rest are kept');
});

test('remembering a key again refreshes its lifetime', () => {
  const c = clock();
  const misses = new MissMemo(30, c.now);
  misses.remember('k');
  c.advance(20);
  misses.remember('k');
  c.advance(20); // 40 s after the first, 20 s after the second
  assert.equal(misses.has('k'), true);
});
