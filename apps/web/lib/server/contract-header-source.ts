/**
 * @file Where the contract header reads its WASM hash from (#448).
 *
 * The header's one side effect, kept out of `lib/contract-header.ts` so that
 * module stays pure: the live instance read (`fetchWasmHash`, #433) and the
 * time the indexer last checked the indexed hash. Neither throws: a failure
 * is `null`, which the model renders as an honest "unavailable" or "as of".
 */
import { cache } from 'react';
import type { Network } from '@signet/types';
import { ALLOW_HTTP, SOROBAN_RPC_URL } from '../chain.ts';
import { logger } from '../logger.ts';
import {
  LIVE_INSTANCE_TTL_SECONDS,
  contractTag,
  nextDataCache,
  type DataCache,
} from './contract-cache.ts';

/** The header sits above every tab, so a slow RPC must not hold the page for long. */
const LIVE_READ_TIMEOUT_MS = 3_000;

/** The slice of `fetchWasmHash` the loader needs; tests inject a stub. */
type FetchWasmHash = (
  address: string,
  opts: { network: Network; rpcUrl: string; allowHttp?: boolean; signal?: AbortSignal },
) => Promise<{ type: 'wasm'; wasmHash: string } | { type: 'stellar_asset' }>;

export interface LiveWasmHashDeps {
  fetchWasmHash?: FetchWasmHash;
  dataCache?: DataCache;
}

/**
 * Live WASM hash from the contract's instance entry; `null` on failure or a
 * Stellar Asset Contract. Remembered for a minute across requests (#458): an
 * upgrade changes the hash without changing the address, so this is the one
 * value that can go stale, and a minute bounds it (Next's data cache serves
 * one stale read after expiry while it refreshes). A failed read is `null` but
 * is not remembered, so a blip is not served back after the RPC recovers; a
 * Stellar Asset Contract is a real answer, so it is.
 */
export function createLiveWasmHashLoader(
  deps: LiveWasmHashDeps = {},
): (address: string, network: Network) => Promise<string | null> {
  const dataCache = deps.dataCache ?? nextDataCache;
  return (address, network) =>
    dataCache.remember<string | null>({
      key: ['contract-live-wasm-hash', network, address],
      tags: [contractTag(address)],
      ttlSeconds: LIVE_INSTANCE_TTL_SECONDS,
      compute: async () => {
        try {
          const fetchWasmHash =
            deps.fetchWasmHash ?? (await import('@signet/spec/fetch')).fetchWasmHash;
          const result = await fetchWasmHash(address, {
            network,
            rpcUrl: SOROBAN_RPC_URL,
            allowHttp: ALLOW_HTTP,
            signal: AbortSignal.timeout(LIVE_READ_TIMEOUT_MS),
          });
          return { value: result.type === 'wasm' ? result.wasmHash : null, cache: true };
        } catch (error) {
          logger.warn({ address, error: String(error) }, 'live wasm hash read failed');
          return { value: null, cache: false };
        }
      },
    });
}

/** One read per render (React `cache`), and at most one per minute per contract across renders. */
export const loadLiveWasmHash = cache(createLiveWasmHashLoader());

/** When the indexer last checked the indexed hash, or `null` without a database or row. */
export const loadIndexedAsOf = cache(async (address: string): Promise<string | null> => {
  if (!process.env.DATABASE_URL) return null;
  try {
    const { prisma } = await import('@signet/db');
    const row = await prisma.contract.findUnique({
      where: { address },
      select: { wasmHashCheckedAt: true },
    });
    return row?.wasmHashCheckedAt?.toISOString() ?? null;
  } catch (error) {
    logger.warn({ address, error: String(error) }, 'indexed wasm hash date lookup failed');
    return null;
  }
});
