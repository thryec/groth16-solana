// Helpers shared by both test files: Anchor client, circuit loading, and upload-if-needed for VKs.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram } from "@solana/web3.js";

import {
  canonicalVkHash,
  reshapeProof,
  reshapePublicInputs,
  reshapeVk,
  type SnarkjsProof,
  type SnarkjsVk,
} from "../ts/src/reshape.js";
import {
  DEFAULT_CU_LIMIT,
  PROGRAM_ID,
  makeProgram,
  makeProvider,
  vkPda,
} from "../ts/src/client.js";
import type { Verifier } from "../target/types/verifier.js";

export { PROGRAM_ID, makeProgram, makeProvider, vkPda };

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Everything a test needs for one circuit: the JSON files, the on-chain byte versions, and the circuit_id.
export interface CircuitArtifacts {
  vkJson: SnarkjsVk;
  proofJson: SnarkjsProof;
  publicJson: string[];
  canonicalVk: Buffer;
  circuitId: Buffer;
  proofBytes: Buffer;
  publicInputs: number[][];
}

// Loads a circuit's JSON files and converts them to the on-chain byte format.
export function loadCircuit(name: "preimage" | "range"): CircuitArtifacts {
  const dir = join(repoRoot, "circuits", name);
  const vkJson = JSON.parse(
    readFileSync(join(dir, "verification_key.json"), "utf8"),
  ) as SnarkjsVk;
  const proofJson = JSON.parse(
    readFileSync(join(dir, "proof.json"), "utf8"),
  ) as SnarkjsProof;
  const publicJson = JSON.parse(
    readFileSync(join(dir, "public.json"), "utf8"),
  ) as string[];

  const canonicalVk = Buffer.from(reshapeVk(vkJson));
  const circuitId = Buffer.from(canonicalVkHash(canonicalVk));
  const proofBytes = Buffer.from(reshapeProof(proofJson));
  const publicInputs = reshapePublicInputs(publicJson).map((u) =>
    Array.from(u),
  );

  return {
    vkJson,
    proofJson,
    publicJson,
    canonicalVk,
    circuitId,
    proofBytes,
    publicInputs,
  };
}

// Uploads the VK only if it's not already on-chain. Safe to re-run.
export async function initVkIfNeeded(
  provider: AnchorProvider,
  program: Program<Verifier>,
  c: CircuitArtifacts,
  cuLimit = DEFAULT_CU_LIMIT,
): Promise<void> {
  const [pda] = vkPda(c.circuitId);
  const existing = await provider.connection.getAccountInfo(pda);
  if (existing) return;
  await program.methods
    .initializeVk(
      Array.from(c.circuitId) as unknown as number[],
      Buffer.from(c.canonicalVk),
    )
    .accounts({ payer: provider.wallet.publicKey })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
    ])
    .rpc({ commitment: "confirmed" });
}

// Airdrops only if the wallet is below the threshold; skips otherwise.
export async function ensureFunded(
  provider: AnchorProvider,
  lamports = 10 * 1_000_000_000,
): Promise<void> {
  const bal = await provider.connection.getBalance(provider.wallet.publicKey);
  if (bal >= lamports) return;
  const sig = await provider.connection.requestAirdrop(
    provider.wallet.publicKey,
    lamports,
  );
  const bh = await provider.connection.getLatestBlockhash();
  await provider.connection.confirmTransaction(
    { signature: sig, ...bh },
    "confirmed",
  );
}
