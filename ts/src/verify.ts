// CLI: verify a Groth16 proof against an uploaded VK.
//   Usage:  tsx ts/src/verify.ts --circuit-id <64-hex> --proof <p.json> --public <pub.json>
//   Stdout: "verified: true" | "verified: false". Exit: 0 verified, 1 not verified, 2 error.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { ComputeBudgetProgram } from "@solana/web3.js";

import {
  DEFAULT_CU_LIMIT,
  makeProgram,
  makeProvider,
} from "./client.js";
import {
  reshapeProof,
  reshapePublicInputs,
  type SnarkjsProof,
} from "./reshape.js";

function fail(msg: string): never {
  process.stderr.write(`verify: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      "circuit-id": { type: "string" },
      proof: { type: "string" },
      public: { type: "string" },
    },
    strict: true,
  });
  const cidHex = values["circuit-id"];
  const proofPath = values.proof;
  const publicPath = values.public;
  if (!cidHex || !proofPath || !publicPath) {
    fail("required: --circuit-id <hex> --proof <path> --public <path>");
  }
  if (!/^[0-9a-fA-F]{64}$/.test(cidHex)) {
    fail("--circuit-id must be 64 hex chars");
  }

  const circuitId = Buffer.from(cidHex, "hex");
  const proofJson = JSON.parse(readFileSync(proofPath, "utf8")) as SnarkjsProof;
  const publicJson = JSON.parse(readFileSync(publicPath, "utf8")) as string[];

  const proofBytes = Buffer.from(reshapeProof(proofJson));
  const publicInputs = reshapePublicInputs(publicJson).map((u) => Array.from(u));

  const provider = makeProvider();
  const program = makeProgram(provider);

  const sig = await program.methods
    .verifyProof(
      Array.from(circuitId) as unknown as number[],
      proofBytes,
      publicInputs as unknown as number[][],
    )
    .accounts({})
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: DEFAULT_CU_LIMIT }),
    ])
    .rpc({ commitment: "confirmed" });

  const tx = await provider.connection.getTransaction(sig, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 0,
  });
  const meta = tx?.meta as unknown as {
    returnData?: { data: [string, string] };
  } | null;
  const rd = meta?.returnData?.data;
  if (!rd) fail("transaction landed but return data was empty");
  const returnByte = Buffer.from(rd[0], rd[1] as BufferEncoding)[0];

  if (returnByte === 0x01) {
    process.stdout.write("verified: true\n");
    process.exit(0);
  }
  if (returnByte === 0x00) {
    process.stdout.write("verified: false\n");
    process.exit(1);
  }
  fail(`unexpected return byte: 0x${returnByte?.toString(16)}`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  fail(msg);
});
