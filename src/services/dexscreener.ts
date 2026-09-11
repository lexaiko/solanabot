import axios from 'axios';
import { TokenMarketData } from '../types/index';

const DEXSCREENER_BASE_URL = 'https://api.dexscreener.com/latest/dex';
let cachedSolPriceUsd = 180.0;
let lastSolPriceFetch = 0;

export async function getSolPriceUsd(): Promise<number> {
  const now = Date.now();
  if (now - lastSolPriceFetch < 60000 && cachedSolPriceUsd > 0) {
    return cachedSolPriceUsd;
  }

  try {
    const res = await axios.get(`${DEXSCREENER_BASE_URL}/tokens/So11111111111111111111111111111111111111112`, {
      timeout: 5000
    });
    const pair = res.data?.pairs?.[0];
    if (pair && pair.priceUsd) {
      cachedSolPriceUsd = parseFloat(pair.priceUsd);
      lastSolPriceFetch = now;
      return cachedSolPriceUsd;
    }
  } catch (err) {
    // Fallback: keep cachedSolPriceUsd
  }
  return cachedSolPriceUsd;
}

// In-Flight Promise Deduplication to prevent simultaneous duplicate HTTP requests
const inFlightRequests: Map<string, Promise<TokenMarketData | null>> = new Map();

// Adaptive cache: 12 seconds for general screening, 4 seconds for active position trailing
const marketDataCache: Map<string, { data: TokenMarketData; timestamp: number }> = new Map();
const DEFAULT_CACHE_TTL_MS = 12000; // 12s eliminates 75%+ HTTP requests
const POSITION_CACHE_TTL_MS = 4000; // 4s for open position tracking

// 429 Circuit Backoff state
let rateLimitCooldownUntil = 0;
let lastRateLimitWarningTime = 0;

export async function getTokenMarketData(tokenAddress: string, forceFresh: boolean = false): Promise<TokenMarketData | null> {
  const now = Date.now();
  const cached = marketDataCache.get(tokenAddress);
  const ttl = forceFresh ? POSITION_CACHE_TTL_MS : DEFAULT_CACHE_TTL_MS;

  // 1. Serve from fresh cache if available
  if (cached && now - cached.timestamp < ttl) {
    return cached.data;
  }

  // 2. Circuit Backoff: If in 429 cooldown, serve stale cache or return null safely
  if (now < rateLimitCooldownUntil) {
    if (cached) {
      return cached.data; // Serve stale cache rather than failing blindly
    }
    return null;
  }

  // 3. In-flight Deduplication: If already fetching this token, await existing promise
  if (inFlightRequests.has(tokenAddress)) {
    return inFlightRequests.get(tokenAddress)!;
  }

  const fetchPromise = (async (): Promise<TokenMarketData | null> => {
    try {
      const res = await axios.get(`${DEXSCREENER_BASE_URL}/tokens/${tokenAddress}`, {
        timeout: 6000
      });

      const pairs = res.data?.pairs;
      if (!pairs || pairs.length === 0) {
        return null;
      }

      // Filter for Solana pairs and pick highest liquidity
      const solanaPairs = pairs.filter((p: any) => p.chainId === 'solana');
      const bestPair = (solanaPairs.length > 0 ? solanaPairs : pairs).sort(
        (a: any, b: any) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0)
      )[0];

      if (!bestPair) return null;

      const data: TokenMarketData = {
        address: tokenAddress,
        symbol: bestPair.baseToken?.symbol || 'UNKNOWN',
        name: bestPair.baseToken?.name || 'Unknown Token',
        priceUsd: parseFloat(bestPair.priceUsd || '0'),
        priceNative: parseFloat(bestPair.priceNative || '0'),
        liquidityUsd: bestPair.liquidity?.usd || 0,
        fdv: bestPair.fdv || 0,
        marketCap: bestPair.marketCap || bestPair.fdv || 0,
        pairAddress: bestPair.pairAddress || '',
        dexId: bestPair.dexId || 'raydium',
        url: bestPair.url || `https://dexscreener.com/solana/${tokenAddress}`,
        priceChange24h: bestPair.priceChange?.h24 || 0,
        priceChange5m: bestPair.priceChange?.m5 || 0,
        priceChange1h: bestPair.priceChange?.h1 || 0,
        priceChange6h: bestPair.priceChange?.h6 || 0,
        volume24h: bestPair.volume?.h24 || 0,
      };

      marketDataCache.set(tokenAddress, { data, timestamp: Date.now() });

      // Periodic memory cleanup
      if (marketDataCache.size > 300) {
        const cleanupNow = Date.now();
        for (const [key, val] of marketDataCache.entries()) {
          if (cleanupNow - val.timestamp > DEFAULT_CACHE_TTL_MS * 3) {
            marketDataCache.delete(key);
          }
        }
      }

      return data;
    } catch (err: any) {
      if (err.response?.status === 429) {
        rateLimitCooldownUntil = Date.now() + 6000; // 6s cooldown
        if (Date.now() - lastRateLimitWarningTime > 15000) {
          lastRateLimitWarningTime = Date.now();
          console.warn('[DexScreener] ⏳ 429 Rate limit detected. Activating 6s circuit backoff & serving from cache.');
        }
        if (cached) return cached.data;
      } else {
        console.error(`[DexScreener] Error fetching data for ${tokenAddress}:`, err.message);
      }
      return cached ? cached.data : null;
    } finally {
      inFlightRequests.delete(tokenAddress);
    }
  })();

  inFlightRequests.set(tokenAddress, fetchPromise);
  return fetchPromise;
}

/**
 * Institutional Risk Utility: Estimates the Price Impact of an order against the liquidity pool
 */
export function calculatePriceImpactPct(orderUsd: number, liquidityUsd: number): number {
  if (!liquidityUsd || liquidityUsd <= 0) return 100.0;
  // Constant-product AMM slippage approximation: Impact ≈ (Order Size / (Pool Liquidity / 2)) * 100
  const poolSideUsd = liquidityUsd / 2;
  return Math.min(100.0, (orderUsd / poolSideUsd) * 100);
}
