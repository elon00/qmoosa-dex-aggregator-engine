import {
  PoolLiquidity,
  AggregatedRouteQuote,
  SplitRoutePath,
  SwapExecutionResult,
  SignedAdminIntent,
  calculateConstantProductOutput,
  calculateSlippageBounds,
  calculatePriceImpact,
  calculateMultiHopOutput,
  calculateOptimalSplit,
  WAD
} from "./types.js";
import { AdminAuthManager } from "./auth.js";

export interface RoutingOptions {
  maxHops?: number;
  maxSplits?: number;
  slippageToleranceBps?: bigint; // Default 50 bps (0.5%)
}

export class DexAggregatorEngine {
  private readonly pools: Map<string, PoolLiquidity> = new Map();
  private readonly tokenAdjacency: Map<string, Set<string>> = new Map();
  private readonly authManager: AdminAuthManager;
  private readonly chainId: number;

  constructor(adminPublicKey: string, chainId: number = 31337) {
    this.authManager = new AdminAuthManager(adminPublicKey, chainId);
    this.chainId = chainId;
  }

  public getAuthManager(): AdminAuthManager {
    return this.authManager;
  }

  public getPool(id: string): PoolLiquidity | undefined {
    const p = this.pools.get(id);
    return p ? { ...p } : undefined;
  }

  public getAllPools(): PoolLiquidity[] {
    return Array.from(this.pools.values()).map(p => ({ ...p }));
  }

  public registerPoolDirect(pool: PoolLiquidity): void {
    if (!pool.id || !pool.dexName || !pool.tokenIn || !pool.tokenOut) {
      throw new Error("INVALID_POOL_METADATA");
    }
    if (pool.reserveIn <= 0n || pool.reserveOut <= 0n) {
      throw new RangeError("RESERVES_MUST_BE_POSITIVE");
    }
    if (pool.feeBps > 1000n) {
      throw new RangeError("FEE_EXCEEDS_1000_BPS");
    }

    const tIn = pool.tokenIn.toUpperCase();
    const tOut = pool.tokenOut.toUpperCase();

    const normalizedPool: PoolLiquidity = {
      ...pool,
      tokenIn: tIn,
      tokenOut: tOut
    };

    this.pools.set(pool.id, normalizedPool);

    if (!this.tokenAdjacency.has(tIn)) this.tokenAdjacency.set(tIn, new Set());
    if (!this.tokenAdjacency.has(tOut)) this.tokenAdjacency.set(tOut, new Set());

    this.tokenAdjacency.get(tIn)!.add(tOut);
  }

  public updatePoolReservesDirect(id: string, reserveIn: bigint, reserveOut: bigint): void {
    const pool = this.pools.get(id);
    if (!pool) throw new Error(`Pool not found: ${id}`);
    if (reserveIn <= 0n || reserveOut <= 0n) throw new RangeError("Reserves must be positive");
    pool.reserveIn = reserveIn;
    pool.reserveOut = reserveOut;
  }

  /**
   * Discovers and evaluates the optimal single-pool, split-pool, or multi-hop swap route.
   */
  public findBestRoute(
    tokenIn: string,
    tokenOut: string,
    amountIn: bigint,
    options: RoutingOptions = {}
  ): AggregatedRouteQuote {
    if (amountIn <= 0n) {
      throw new RangeError("ZERO_OR_NEGATIVE_AMOUNT_IN");
    }

    const tIn = tokenIn.toUpperCase();
    const tOut = tokenOut.toUpperCase();
    const slippageBps = options.slippageToleranceBps ?? 50n;

    if (tIn === tOut) {
      throw new Error("IDENTICAL_TOKENS: Cannot swap a token for itself");
    }

    // 1. Find all candidate direct pools
    const directPools: PoolLiquidity[] = [];
    for (const pool of this.pools.values()) {
      if (pool.tokenIn === tIn && pool.tokenOut === tOut) {
        directPools.push(pool);
      }
    }

    let candidateQuotes: Array<{ paths: SplitRoutePath[]; totalAmountOut: bigint }> = [];

    // Evaluate single pool options
    for (const pool of directPools) {
      try {
        const out = calculateConstantProductOutput(amountIn, pool.reserveIn, pool.reserveOut, pool.feeBps);
        candidateQuotes.push({
          totalAmountOut: out,
          paths: [
            {
              percentBps: 10000n,
              amountIn,
              expectedAmountOut: out,
              hops: [
                {
                  poolId: pool.id,
                  dexName: pool.dexName,
                  tokenIn: pool.tokenIn,
                  tokenOut: pool.tokenOut,
                  feeBps: pool.feeBps
                }
              ]
            }
          ]
        });
      } catch {
        // Skip insolvent pool
      }
    }

    // Evaluate 2-pool split combinations if multiple pools exist
    if (directPools.length >= 2) {
      for (let i = 0; i < directPools.length; i++) {
        for (let j = i + 1; j < directPools.length; j++) {
          const poolA = directPools[i];
          const poolB = directPools[j];

          const split = calculateOptimalSplit(amountIn, poolA, poolB);
          if (split.totalAmountOut > 0n && split.amountInA > 0n && split.amountInB > 0n) {
            const outA = calculateConstantProductOutput(split.amountInA, poolA.reserveIn, poolA.reserveOut, poolA.feeBps);
            const outB = calculateConstantProductOutput(split.amountInB, poolB.reserveIn, poolB.reserveOut, poolB.feeBps);

            candidateQuotes.push({
              totalAmountOut: split.totalAmountOut,
              paths: [
                {
                  percentBps: split.percentA,
                  amountIn: split.amountInA,
                  expectedAmountOut: outA,
                  hops: [
                    {
                      poolId: poolA.id,
                      dexName: poolA.dexName,
                      tokenIn: poolA.tokenIn,
                      tokenOut: poolA.tokenOut,
                      feeBps: poolA.feeBps
                    }
                  ]
                },
                {
                  percentBps: split.percentB,
                  amountIn: split.amountInB,
                  expectedAmountOut: outB,
                  hops: [
                    {
                      poolId: poolB.id,
                      dexName: poolB.dexName,
                      tokenIn: poolB.tokenIn,
                      tokenOut: poolB.tokenOut,
                      feeBps: poolB.feeBps
                    }
                  ]
                }
              ]
            });
          }
        }
      }
    }

    // 2. Evaluate 2-hop paths (tokenIn -> intermediate -> tokenOut)
    const intermediateTokens = this.tokenAdjacency.get(tIn);
    if (intermediateTokens) {
      for (const inter of intermediateTokens) {
        if (inter === tOut || inter === tIn) continue;

        // Check if intermediate has direct pool to tOut
        for (const pool1 of this.pools.values()) {
          if (pool1.tokenIn === tIn && pool1.tokenOut === inter) {
            for (const pool2 of this.pools.values()) {
              if (pool2.tokenIn === inter && pool2.tokenOut === tOut) {
                try {
                  const out1 = calculateConstantProductOutput(amountIn, pool1.reserveIn, pool1.reserveOut, pool1.feeBps);
                  const out2 = calculateConstantProductOutput(out1, pool2.reserveIn, pool2.reserveOut, pool2.feeBps);

                  candidateQuotes.push({
                    totalAmountOut: out2,
                    paths: [
                      {
                        percentBps: 10000n,
                        amountIn,
                        expectedAmountOut: out2,
                        hops: [
                          {
                            poolId: pool1.id,
                            dexName: pool1.dexName,
                            tokenIn: pool1.tokenIn,
                            tokenOut: pool1.tokenOut,
                            feeBps: pool1.feeBps
                          },
                          {
                            poolId: pool2.id,
                            dexName: pool2.dexName,
                            tokenIn: pool2.tokenIn,
                            tokenOut: pool2.tokenOut,
                            feeBps: pool2.feeBps
                          }
                        ]
                      }
                    ]
                  });
                } catch {
                  // Skip invalid path
                }
              }
            }
          }
        }
      }
    }

    if (candidateQuotes.length === 0) {
      throw new Error(`NO_ROUTE_FOUND: No liquidity paths exist between ${tIn} and ${tOut}`);
    }

    // Pick highest output route
    candidateQuotes.sort((a, b) => (b.totalAmountOut > a.totalAmountOut ? 1 : -1));
    const best = candidateQuotes[0];

    const { minAmountOut } = calculateSlippageBounds(best.totalAmountOut, slippageBps);

    // Aggregate effective pool reserves for price impact estimation
    let totalRIn = 0n;
    let totalROut = 0n;
    for (const p of directPools) {
      totalRIn += p.reserveIn;
      totalROut += p.reserveOut;
    }
    const priceImpactBps = (totalRIn > 0n && totalROut > 0n)
      ? calculatePriceImpact(amountIn, best.totalAmountOut, totalRIn, totalROut)
      : 50n;

    const executionPriceWad = (best.totalAmountOut * WAD) / amountIn;

    return {
      tokenIn: tIn,
      tokenOut: tOut,
      totalAmountIn: amountIn,
      totalExpectedAmountOut: best.totalAmountOut,
      minAmountOut,
      slippageToleranceBps: slippageBps,
      priceImpactBps,
      executionPriceWad,
      paths: best.paths
    };
  }

  /**
   * Executes atomic swap quote, verifies minimum output, and mutates underlying reserves.
   */
  public async executeSwap(
    quote: AggregatedRouteQuote,
    recipient: string = "0xTrader"
  ): Promise<SwapExecutionResult> {
    if (quote.totalAmountIn <= 0n) {
      throw new Error("INVALID_SWAP_AMOUNT");
    }

    let actualAmountOut = 0n;

    // Snapshot pool state for rollback capability
    const snapshots: Array<{ id: string; rIn: bigint; rOut: bigint }> = [];

    try {
      for (const path of quote.paths) {
        let currentLegAmount = path.amountIn;

        for (const hop of path.hops) {
          const pool = this.pools.get(hop.poolId);
          if (!pool) throw new Error(`POOL_NOT_FOUND: ${hop.poolId}`);

          snapshots.push({ id: pool.id, rIn: pool.reserveIn, rOut: pool.reserveOut });

          const legOut = calculateConstantProductOutput(
            currentLegAmount,
            pool.reserveIn,
            pool.reserveOut,
            pool.feeBps
          );

          // Update pool reserves
          pool.reserveIn += currentLegAmount;
          pool.reserveOut -= legOut;

          currentLegAmount = legOut;
        }

        actualAmountOut += currentLegAmount;
      }

      // Slippage check
      if (actualAmountOut < quote.minAmountOut) {
        throw new Error(
          `SLIPPAGE_LIMIT_EXCEEDED: Realized output ${actualAmountOut} < minimum guaranteed ${quote.minAmountOut}`
        );
      }

      return {
        txId: `tx_agg_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        tokenIn: quote.tokenIn,
        tokenOut: quote.tokenOut,
        amountIn: quote.totalAmountIn,
        expectedAmountOut: quote.totalExpectedAmountOut,
        actualAmountOut,
        minAmountOut: quote.minAmountOut,
        priceImpactBps: quote.priceImpactBps,
        recipient,
        pathsUsed: quote.paths.length,
        timestamp: Date.now(),
        success: true
      };
    } catch (err: any) {
      // Rollback snapshots
      for (const s of snapshots) {
        const p = this.pools.get(s.id);
        if (p) {
          p.reserveIn = s.rIn;
          p.reserveOut = s.rOut;
        }
      }
      throw err;
    }
  }

  public executeAdminIntent(intent: SignedAdminIntent): void {
    this.authManager.verifyAndConsume(intent);

    switch (intent.action) {
      case "REGISTER_POOL": {
        const { id, dexName, tokenIn, tokenOut, reserveIn, reserveOut, feeBps } = intent.params;
        this.registerPoolDirect({
          id,
          dexName,
          tokenIn,
          tokenOut,
          reserveIn: BigInt(reserveIn),
          reserveOut: BigInt(reserveOut),
          feeBps: BigInt(feeBps ?? 30)
        });
        break;
      }
      case "UPDATE_POOL_RESERVES": {
        const { id, reserveIn, reserveOut } = intent.params;
        this.updatePoolReservesDirect(id, BigInt(reserveIn), BigInt(reserveOut));
        break;
      }
      case "SET_POOL_FEE": {
        const { id, feeBps } = intent.params;
        const pool = this.pools.get(id);
        if (!pool) throw new Error(`Pool not found: ${id}`);
        pool.feeBps = BigInt(feeBps);
        break;
      }
      default:
        throw new Error(`Unsupported admin action: ${intent.action}`);
    }
  }
}
