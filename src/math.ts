export const BPS_DIVISOR = 10000n;
export const WAD = 10n ** 18n;

/**
 * Calculates output amount for standard constant-product AMM (x * y = k)
 */
export function calculateConstantProductOutput(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint = 30n
): bigint {
  if (amountIn <= 0n) {
    throw new RangeError("INSUFFICIENT_INPUT_AMOUNT: amountIn must be strictly positive");
  }
  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new RangeError("INSUFFICIENT_LIQUIDITY: reserves must be strictly positive");
  }
  if (feeBps >= BPS_DIVISOR) {
    throw new RangeError("FEE_EXCEEDS_MAX: feeBps must be strictly less than 10000");
  }

  const amountInWithFee = amountIn * (BPS_DIVISOR - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = (reserveIn * BPS_DIVISOR) + amountInWithFee;

  return numerator / denominator;
}

/**
 * Calculates minimum amount out guaranteed by slippage tolerance
 */
export function calculateSlippageBounds(
  expectedAmountOut: bigint,
  slippageToleranceBps: bigint
): { minAmountOut: bigint; maxSlippageAmount: bigint } {
  if (expectedAmountOut <= 0n) {
    throw new RangeError("Amount out must be positive");
  }
  if (slippageToleranceBps > BPS_DIVISOR) {
    throw new RangeError("Slippage tolerance exceeds 10000 bps");
  }

  const maxSlippageAmount = (expectedAmountOut * slippageToleranceBps) / BPS_DIVISOR;
  const minAmountOut = expectedAmountOut - maxSlippageAmount;

  return { minAmountOut, maxSlippageAmount };
}

/**
 * Computes price impact in basis points (1 bp = 0.01%)
 */
export function calculatePriceImpact(
  amountIn: bigint,
  amountOut: bigint,
  reserveIn: bigint,
  reserveOut: bigint
): bigint {
  if (amountIn <= 0n || amountOut <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    return 0n;
  }

  // Spot price = reserveOut / reserveIn
  // Effective execution price = amountOut / amountIn
  const spotRateWad = (reserveOut * WAD) / reserveIn;
  const effectiveRateWad = (amountOut * WAD) / amountIn;

  if (effectiveRateWad >= spotRateWad) {
    return 0n; // Negligible or zero impact
  }

  const deltaWad = spotRateWad - effectiveRateWad;
  return (deltaWad * BPS_DIVISOR) / spotRateWad;
}

/**
 * Evaluates multi-hop sequential swaps along a path of pools
 */
export function calculateMultiHopOutput(
  amountIn: bigint,
  hops: Array<{ reserveIn: bigint; reserveOut: bigint; feeBps: bigint }>
): bigint {
  if (hops.length === 0) {
    throw new Error("EMPTY_HOP_PATH");
  }

  let currentAmount = amountIn;
  for (const hop of hops) {
    currentAmount = calculateConstantProductOutput(
      currentAmount,
      hop.reserveIn,
      hop.reserveOut,
      hop.feeBps
    );
  }
  return currentAmount;
}

/**
 * Computes optimal split between two parallel liquidity pools
 * by evaluating marginal returns across discrete granularity slices.
 */
export function calculateOptimalSplit(
  totalAmountIn: bigint,
  poolA: { reserveIn: bigint; reserveOut: bigint; feeBps: bigint },
  poolB: { reserveIn: bigint; reserveOut: bigint; feeBps: bigint }
): { percentA: bigint; percentB: bigint; amountInA: bigint; amountInB: bigint; totalAmountOut: bigint } {
  if (totalAmountIn <= 0n) {
    throw new RangeError("totalAmountIn must be positive");
  }

  let bestOut = 0n;
  let bestPercentA = 10000n;

  // Evaluate candidate split steps from 0% to 100% in 500 bps (5%) increments
  for (let percent = 0n; percent <= 10000n; percent += 500n) {
    const inA = (totalAmountIn * percent) / 10000n;
    const inB = totalAmountIn - inA;

    let outA = 0n;
    let outB = 0n;

    if (inA > 0n) {
      outA = calculateConstantProductOutput(inA, poolA.reserveIn, poolA.reserveOut, poolA.feeBps);
    }
    if (inB > 0n) {
      outB = calculateConstantProductOutput(inB, poolB.reserveIn, poolB.reserveOut, poolB.feeBps);
    }

    const currentTotalOut = outA + outB;
    if (currentTotalOut > bestOut) {
      bestOut = currentTotalOut;
      bestPercentA = percent;
    }
  }

  const finalInA = (totalAmountIn * bestPercentA) / 10000n;
  const finalInB = totalAmountIn - finalInA;

  return {
    percentA: bestPercentA,
    percentB: 10000n - bestPercentA,
    amountInA: finalInA,
    amountInB: finalInB,
    totalAmountOut: bestOut
  };
}
