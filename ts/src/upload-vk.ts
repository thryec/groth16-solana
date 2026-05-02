// CLI: upload a VK to a content-addressed PDA.
//   Usage:  tsx ts/src/upload-vk.ts --vk <verification_key.json>
//   Stdout: hex circuit_id. Exit: 0 success, 2 error.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ComputeBudgetProgram } from "@solana/web3.js";

import {
  DEFAULT_CU_LIMIT,
  makeProgram,
  makeProvider,
  vkPda,
} from "./client.js";
import { canonicalVkHash, reshapeVk, type SnarkjsVk } from "./reshape.js";

function die(msg: string): never {
  process.stderr.write(`upload-vk: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { vk: { type: "string" } },
    strict: true,
  });
  if (!values.vk) die("missing required --vk <path>");

  const vkJson = JSON.parse(readFileSync(values.vk, "utf8")) as SnarkjsVk;
  const canonical = Buffer.from(reshapeVk(vkJson));
  const circuitId = Buffer.from(canonicalVkHash(canonical));

  const provider = makeProvider();
  const program = makeProgram(provider);

  // Content-addressed PDA: existence at this seed under our program's ownership implies
  // the bytes already match — nothing else could occupy [b"vk", circuit_id]. Skip the tx.
  const [pda] = vkPda(circuitId);
  const existing = await provider.connection.getAccountInfo(pda);
  if (existing && existing.owner.equals(program.programId)) {
    process.stdout.write(`${circuitId.toString("hex")}\n`);
    return;
  }

  await program.methods
    .initializeVk(
      Array.from(circuitId) as unknown as number[],
      canonical,
    )
    .accounts({ payer: provider.wallet.publicKey })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_LIMIT }),
    ])
    .rpc({ commitment: "confirmed" });

  process.stdout.write(`${circuitId.toString("hex")}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  die(msg);
});
