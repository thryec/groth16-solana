// Records compute-unit usage per circuit and the largest number of public inputs that fits in one transaction. Output: artifacts/measurements.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";
import {
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";

import {
  ensureFunded,
  initVkIfNeeded,
  loadCircuit,
  makeProgram,
  makeProvider,
} from "./helpers.js";
import { canonicalVkHash } from "../ts/src/reshape.js";

const TX_WIRE_LIMIT = 1232; // max bytes in a Solana v0 transaction
const CU_LIMIT = 400_000;
const PUBLIC_INPUT_COUNTS = [1, 2, 4, 8, 12, 16, 20];

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactsDir = join(repoRoot, "artifacts");

const provider = makeProvider();
const program = makeProgram(provider);

interface Measurements {
  verify_cu: { preimage: number; range: number };
  one_shot_max_public_inputs: number;
}

const results: Measurements = {
  verify_cu: { preimage: 0, range: 0 },
  one_shot_max_public_inputs: 0,
};

beforeAll(async () => {
  await ensureFunded(provider);
  await initVkIfNeeded(provider, program, loadCircuit("preimage"));
  await initVkIfNeeded(provider, program, loadCircuit("range"));
});

// Runs the tx in simulation (no actual send) to read the compute-unit cost. Skips signature checks since we're not paying.
async function simulateVerify(
  circuit: "preimage" | "range",
): Promise<number> {
  const c = loadCircuit(circuit);
  const ix = await program.methods
    .verifyProof(
      Array.from(c.circuitId) as unknown as number[],
      c.proofBytes,
      c.publicInputs as unknown as number[][],
    )
    .accounts({})
    .instruction();
  const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT });
  const bh = await provider.connection.getLatestBlockhash();
  const message = new TransactionMessage({
    payerKey: provider.wallet.publicKey,
    recentBlockhash: bh.blockhash,
    instructions: [cuIx, ix],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  const signed = await provider.wallet.signTransaction(tx);
  const sim = await provider.connection.simulateTransaction(signed, {
    sigVerify: false,
  });
  expect(sim.value.err).toBeNull();
  return sim.value.unitsConsumed ?? 0;
}

// Builds a VK with the right byte layout but fake curve points. The salt makes each one hash to a different circuit_id so they don't conflict.
function synthesizeCanonicalVk(icCount: number, salt: number): Buffer {
  const size = 452 + icCount * 64;
  const buf = Buffer.alloc(size);
  buf.writeUInt32LE(icCount, 448);
  buf.writeUInt32LE(salt, 0);
  return buf;
}

// Returns true if the tx fits in one Solana transaction. Any failure counts as "didn't fit".
async function tryOneShotInit(nPublic: number): Promise<boolean> {
  try {
    const icCount = nPublic + 1;
    const vkBytes = synthesizeCanonicalVk(
      icCount,
      randomBytes(4).readUInt32LE(),
    );
    const circuitId = Buffer.from(canonicalVkHash(vkBytes));

    const ix = await program.methods
      .initializeVk(
        Array.from(circuitId) as unknown as number[],
        vkBytes,
      )
      .accounts({ payer: provider.wallet.publicKey })
      .instruction();
    const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT });
    const bh = await provider.connection.getLatestBlockhash();
    const message = new TransactionMessage({
      payerKey: provider.wallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: [cuIx, ix],
    }).compileToV0Message();
    const tx = new VersionedTransaction(message);
    const signed = await provider.wallet.signTransaction(tx);

    if (signed.serialize().length > TX_WIRE_LIMIT) return false;

    const sig = await provider.connection.sendRawTransaction(signed.serialize());
    const confirmBh = await provider.connection.getLatestBlockhash();
    await provider.connection.confirmTransaction(
      { signature: sig, ...confirmBh },
      "confirmed",
    );
    return true;
  } catch {
    return false;
  }
}

describe("measurements", () => {
  it("records verify_proof CU for both circuits", async () => {
    results.verify_cu.preimage = await simulateVerify("preimage");
    results.verify_cu.range = await simulateVerify("range");
    expect(results.verify_cu.preimage).toBeGreaterThan(0);
    expect(results.verify_cu.range).toBeGreaterThan(0);
  });

  // Finds the largest n that still fits. Lands at n=4: VK is 452+5×64=772 bytes; tx overhead pushes it close to the 1232-byte limit.
  it("finds the highest one-shot public-input count for initialize_vk", async () => {
    let best = 0;
    for (const n of PUBLIC_INPUT_COUNTS) {
      if (await tryOneShotInit(n)) best = n;
    }
    results.one_shot_max_public_inputs = best;
    expect(best).toBeGreaterThan(0);
  });

  it("writes artifacts/measurements.json", () => {
    mkdirSync(artifactsDir, { recursive: true });
    writeFileSync(
      join(artifactsDir, "measurements.json"),
      JSON.stringify(results, null, 2) + "\n",
    );
  });
});
