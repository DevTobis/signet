import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeContractWithDeps,
  withAttributionCache,
  type AttributionDb,
  type AttributionDbRow,
} from './contract-attribution.ts';
import { MissMemo, contractTag, createMemoryDataCache } from './server/contract-cache.ts';

const ADDRESS = 'CASFJHI5PQSRWS7JV25CF7FOMRKIVBP3RXRP3E2GH2CV4BCAG7FUJRCN';
const OTHER_ADDRESS = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const ROW: AttributionDbRow = {
  address: ADDRESS,
  network: 'testnet',
  deployerPubkey: 'GDEPLOYER',
  deployTxHash: 'ab'.repeat(32),
  deployedAt: '2026-03-01T12:00:00.000Z',
  wasmHash: 'cd'.repeat(32),
  walletId: 'w1',
  walletPubkey: 'GDEPLOYER',
};

/** A hand-moved clock, in milliseconds. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (seconds: number) => void (t += seconds * 1000) };
}

/** The database seam with a call counter and a swappable answer. */
function countingDb(initial: AttributionDbRow | null | undefined) {
  const db = {
    calls: 0,
    answer: initial,
    findContract: async () => {
      db.calls += 1;
      return db.answer;
    },
  };
  return db;
}

function setup(initial: AttributionDbRow | null | undefined) {
  const c = clock();
  const inner = countingDb(initial);
  const dataCache = createMemoryDataCache(c.now);
  const misses = new MissMemo(30, c.now);
  const db: AttributionDb = withAttributionCache(inner, { dataCache, misses });
  const ask = (handle = 'alice', address = ADDRESS) =>
    attributeContractWithDeps(handle, address, { db, network: 'testnet' });
  return { c, inner, dataCache, misses, db, ask };
}

// --- a match ---------------------------------------------------------------------

// The layout, `generateMetadata` and the page each ask for the verdict. Within one
// render React's `cache()` already runs `attributeContract` once; this is the
// cross-request layer under it, and it must hold on its own: three asks one after
// another, as the layout then the page make them, are one database query.
test('layout, metadata and page asking in turn cost one database query', async () => {
  const { inner, ask } = setup(ROW);

  for (const caller of ['layout', 'metadata', 'page']) {
    assert.equal((await ask()).status, 'attributed', caller);
  }

  assert.equal(inner.calls, 1);
});

test('a match is remembered for 5 minutes, then asked again', async () => {
  const { c, inner, ask } = setup(ROW);

  await ask();
  c.advance(299);
  await ask();
  assert.equal(inner.calls, 1);

  c.advance(2); // 301 s
  await ask();
  assert.equal(inner.calls, 2);
});

test('a remembered match round-trips through JSON: the deploy date survives as the string it becomes', async () => {
  const withDate: AttributionDbRow = { ...ROW, deployedAt: new Date('2026-03-01T12:00:00.000Z') };
  const { ask } = setup(withDate);

  const first = await ask();
  const second = await ask();

  for (const verdict of [first, second]) {
    assert.equal(verdict.status, 'attributed');
    if (verdict.status === 'attributed') assert.equal(verdict.contract.deployedAt, '2026-03-01T12:00:00.000Z');
  }
});

test('a match is dropped by its contract tag', async () => {
  const { dataCache, inner, ask } = setup(ROW);
  await ask();
  dataCache.clear(contractTag(ADDRESS));
  await ask();
  assert.equal(inner.calls, 2);
});

// --- a miss ------------------------------------------------------------------------

test('a miss is remembered for 30 seconds', async () => {
  const { c, inner, ask } = setup(null);

  assert.equal((await ask()).status, 'not-attributed');
  c.advance(29);
  assert.equal((await ask()).status, 'not-attributed');
  assert.equal(inner.calls, 1, 'the second ask did not reach the database');

  c.advance(1); // 30 s
  await ask();
  assert.equal(inner.calls, 2);
});

test('a deployment the indexer records appears within 30 seconds of the first miss', async () => {
  const { c, inner, ask } = setup(null);

  assert.equal((await ask()).status, 'not-attributed');

  inner.answer = ROW; // the indexer has just recorded the deployment
  c.advance(15);
  assert.equal((await ask()).status, 'not-attributed', 'still inside the miss window');

  c.advance(15); // 30 s after the first miss
  assert.equal((await ask()).status, 'attributed');
});

test('once a deployment appears it is remembered as a match, whatever the row does next', async () => {
  const { c, inner, ask } = setup(null);
  await ask();
  inner.answer = ROW;
  c.advance(31);
  assert.equal((await ask()).status, 'attributed');

  inner.answer = null; // even if the row vanished, the match stands for its 5 minutes
  c.advance(60);
  assert.equal((await ask()).status, 'attributed');
});

// --- an unavailable database --------------------------------------------------------

test('"no database" is never remembered, so an outage cannot outlive its cause', async () => {
  const { inner, ask } = setup(undefined);

  // No DB means the Horizon fallback runs; give it nothing to find.
  const horizon = {
    listWallets: async () => [] as string[],
    listOperations: async () => null,
    getResultMetaXdr: async () => null,
  };
  const askNoDb = () =>
    attributeContractWithDeps('alice', ADDRESS, {
      db: withAttributionCache(inner, {
        dataCache: createMemoryDataCache(),
        misses: new MissMemo(),
      }),
      horizon,
      network: 'testnet',
    });

  await askNoDb();
  assert.equal(inner.calls, 1);
  await askNoDb();
  assert.equal(inner.calls, 2, 'the second ask went back to the database');
});

test('the database coming back is seen on the very next ask after an outage', async () => {
  const c = clock();
  const inner = countingDb(undefined);
  const db = withAttributionCache(inner, {
    dataCache: createMemoryDataCache(c.now),
    misses: new MissMemo(30, c.now),
  });
  const ask = () =>
    attributeContractWithDeps('alice', ADDRESS, {
      db,
      network: 'testnet',
      horizon: { listWallets: async () => [], listOperations: async () => null, getResultMetaXdr: async () => null },
    });

  await ask();
  inner.answer = ROW;
  assert.equal((await ask()).status, 'attributed');
});

// --- keys ----------------------------------------------------------------------------

test('another address, handle or network is a separate entry', async () => {
  const { inner, ask } = setup(ROW);
  await ask('alice', ADDRESS);
  await ask('bob', ADDRESS);
  await ask('alice', OTHER_ADDRESS);
  assert.equal(inner.calls, 3);
});

test('the handle is case-insensitive in the key, as it is in the query', async () => {
  const { db, inner } = setup(ROW);

  await db.findContract({ address: ADDRESS, handle: 'Alice', network: 'testnet' });
  await db.findContract({ address: ADDRESS, handle: 'alice', network: 'testnet' });

  assert.equal(inner.calls, 1);
});

test('invalid input never reaches the cache or the database', async () => {
  const { inner, ask } = setup(ROW);
  assert.equal((await ask('alice', 'not-an-address')).status, 'invalid');
  assert.equal(inner.calls, 0);
});
