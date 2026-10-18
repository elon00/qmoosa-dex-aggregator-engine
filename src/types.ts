export * from "@qmoosa/dex-aggregator-protocol";

export type AdminActionType =
  | "REGISTER_POOL"
  | "UPDATE_POOL_RESERVES"
  | "SET_POOL_FEE"
  | "SET_POOL_PAUSED";

export interface SignedAdminIntent {
  action: AdminActionType;
  params: Record<string, any>;
  nonce: number;
  deadline: number;
  domain: string;
  signature: string;
}

export interface SwapExecutionResult {
  txId: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  expectedAmountOut: bigint;
  actualAmountOut: bigint;
  minAmountOut: bigint;
  priceImpactBps: bigint;
  recipient: string;
  pathsUsed: number;
  timestamp: number;
  success: boolean;
}
