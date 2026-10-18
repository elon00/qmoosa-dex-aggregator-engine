export interface PoolLiquidity {
  id: string;
  dexName: string;
  tokenIn: string;
  tokenOut: string;
  reserveIn: bigint;
  reserveOut: bigint;
  feeBps: bigint;
}

export interface RouteHop {
  poolId: string;
  dexName: string;
  tokenIn: string;
  tokenOut: string;
  feeBps: bigint;
}

export interface SplitRoutePath {
  percentBps: bigint;
  amountIn: bigint;
  expectedAmountOut: bigint;
  hops: RouteHop[];
}

export interface AggregatedRouteQuote {
  tokenIn: string;
  tokenOut: string;
  totalAmountIn: bigint;
  totalExpectedAmountOut: bigint;
  minAmountOut: bigint;
  slippageToleranceBps: bigint;
  priceImpactBps: bigint;
  executionPriceWad: bigint;
  paths: SplitRoutePath[];
}
