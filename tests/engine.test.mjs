import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  DexAggregatorEngine,
  AdminAuthManager
} from "../dist/index.js";

function setupEngine() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" }
  });

  const engine = new DexAggregatorEngine(publicKey, 31337);

  // Pool 1: QmoosaAMM USDC -> WETH
  engine.registerPoolDirect({
    id: "pool_qmoosa_usdc_weth",
    dexName: "QmoosaAMM",
    tokenIn: "USDC",
    tokenOut: "WETH",
    reserveIn: 1_000_000n * 10n ** 6n,
    reserveOut: 500n * 10n ** 18n,
    feeBps: 30n
  });

  // Pool 2: Sushiswap USDC -> WETH (Identical size)
  engine.registerPoolDirect({
    id: "pool_sushi_usdc_weth",
    dexName: "Sushiswap",
    tokenIn: "USDC",
    tokenOut: "WETH",
    reserveIn: 1_000_000n * 10n ** 6n,
    reserveOut: 500n * 10n ** 18n,
    feeBps: 30n
  });

  // Pool 3: Curve WETH -> DAI
  engine.registerPoolDirect({
    id: "pool_curve_weth_dai",
    dexName: "Curve",
    tokenIn: "WETH",
    tokenOut: "DAI",
    reserveIn: 500n * 10n ** 18n,
    reserveOut: 1_000_000n * 10n ** 18n,
    feeBps: 10n
  });

  return { engine, publicKey, privateKey };
}

test("1. Direct single-pool swap route discovery", () => {
  const { engine } = setupEngine();
  const quote = engine.findBestRoute("USDC", "WETH", 5000n * 10n ** 6n);

  assert.equal(quote.tokenIn, "USDC");
  assert.equal(quote.tokenOut, "WETH");
  assert.ok(quote.totalExpectedAmountOut > 0n);
  assert.ok(quote.minAmountOut > 0n);
});

test("2. Multi-pool optimal split routing under high trade size", () => {
  const { engine } = setupEngine();
  // Large swap: 200,000 USDC (10% of each pool) -> Split across QmoosaAMM and Sushiswap
  const quote = engine.findBestRoute("USDC", "WETH", 200_000n * 10n ** 6n);

  assert.equal(quote.paths.length, 2);
  const sumPercent = quote.paths.reduce((acc, p) => acc + p.percentBps, 0n);
  assert.equal(sumPercent, 10000n);

  const sumIn = quote.paths.reduce((acc, p) => acc + p.amountIn, 0n);
  assert.equal(sumIn, 200_000n * 10n ** 6n);
});

test("3. Multi-hop routing across intermediary token (USDC -> WETH -> DAI)", () => {
  const { engine } = setupEngine();
  const quote = engine.findBestRoute("USDC", "DAI", 10_000n * 10n ** 6n);

  assert.equal(quote.tokenIn, "USDC");
  assert.equal(quote.tokenOut, "DAI");
  assert.ok(quote.paths[0].hops.length >= 2);
  assert.equal(quote.paths[0].hops[0].tokenIn, "USDC");
  assert.equal(quote.paths[0].hops[0].tokenOut, "WETH");
  assert.equal(quote.paths[0].hops[1].tokenIn, "WETH");
  assert.equal(quote.paths[0].hops[1].tokenOut, "DAI");
});

test("4. Atomic swap execution and reserve mutation", async () => {
  const { engine } = setupEngine();
  const pool = engine.getPool("pool_qmoosa_usdc_weth");
  const initRIn = pool.reserveIn;
  const initROut = pool.reserveOut;

  const quote = engine.findBestRoute("USDC", "WETH", 10_000n * 10n ** 6n);
  const receipt = await engine.executeSwap(quote, "0xTraderAlice");

  assert.equal(receipt.success, true);
  assert.equal(receipt.recipient, "0xTraderAlice");
  assert.ok(receipt.actualAmountOut >= quote.minAmountOut);

  // Verify pool reserves mutated
  const updatedPool = engine.getPool("pool_qmoosa_usdc_weth");
  assert.ok(updatedPool.reserveIn > initRIn);
  assert.ok(updatedPool.reserveOut < initROut);
});

test("5. Slippage limit defense strictly rejects deficient execution", async () => {
  const { engine } = setupEngine();
  const quote = engine.findBestRoute("USDC", "WETH", 10_000n * 10n ** 6n);

  // Artificially demand impossible minAmountOut
  quote.minAmountOut = quote.totalExpectedAmountOut * 2n;

  await assert.rejects(
    () => engine.executeSwap(quote, "0xTrader"),
    /SLIPPAGE_LIMIT_EXCEEDED/
  );
});

test("6. Asymmetric Ed25519 admin intents & replay defense", () => {
  const { engine, privateKey } = setupEngine();
  const domain = engine.getAuthManager().getExpectedDomain();
  const now = Math.floor(Date.now() / 1000);

  const intent = AdminAuthManager.signAdminIntent(
    "SET_POOL_FEE",
    { id: "pool_qmoosa_usdc_weth", feeBps: 15 },
    1,
    now + 300,
    domain,
    privateKey
  );

  engine.executeAdminIntent(intent);
  assert.equal(engine.getPool("pool_qmoosa_usdc_weth").feeBps, 15n);

  // Replay attempt with same nonce must be rejected
  assert.throws(
    () => engine.executeAdminIntent(intent),
    /Nonce replay rejected/
  );
});
