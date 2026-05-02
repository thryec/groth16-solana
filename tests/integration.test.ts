// Integration tests against the deployed verifier program. Reads each circuit's JSON from disk.
import { beforeAll, describe, expect, it } from "vitest";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { randomBytes } from "node:crypto";

import {
  CircuitArtifacts,
  ensureFunded,
  initVkIfNeeded,
  loadCircuit,
  makeProgram,
  makeProvider,
  vkPda,
} from "./helpers.js";
import { canonicalVkHash, reshapeVk } from "../ts/src/reshape.js";

const CU_LIMIT = 400_000;

const provider = makeProvider();
const program = makeProgram(provider);

let preimage: CircuitArtifacts;
let range: CircuitArtifacts;

// Calls initialize_vk through the Anchor client.
async function initVk(c: CircuitArtifacts): Promise<string> {
  return program.methods
    .initializeVk(
      Array.from(c.circuitId) as unknown as number[],
      Buffer.from(c.canonicalVk),
    )
    .accounts({ payer: provider.wallet.publicKey })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ])
    .rpc({ commitment: "confirmed" });
}

// Like initVk but takes raw bytes, so tests 6 and 7 can submit deliberately bad VKs.
async function initVkRaw(
  circuitId: Buffer,
  vkBytes: Buffer,
): Promise<string> {
  return program.methods
    .initializeVk(
      Array.from(circuitId) as unknown as number[],
      vkBytes,
    )
    .accounts({ payer: provider.wallet.publicKey })
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
    ])
    .rpc({ commitment: "confirmed" });
}

// Shared setup. Safe to re-run; won't fail if a previous run already initialized things.
beforeAll(async () => {
  await ensureFunded(provider);
  preimage = loadCircuit("preimage");
  range = loadCircuit("range");
  await initVkIfNeeded(provider, program, preimage);
  await initVkIfNeeded(provider, program, range);
});

// Calls verify_proof and returns the result byte. null means the tx failed entirely (not that the proof was just rejected).
async function runVerify(
  circuitId: Buffer,
  proofBytes: Buffer,
  publicInputs: number[][],
): Promise<{ sig: string; returnData: Buffer | null }> {
  const sig = await program.methods
    .verifyProof(
      Array.from(circuitId) as unknown as number[],
      proofBytes,
      publicInputs as unknown as number[][],
    )
    .accounts({})
    .preInstructions([
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_LIMIT }),
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
  const returnData = rd ? Buffer.from(rd[0], rd[1] as BufferEncoding) : null;
  return { sig, returnData };
}

function flipByte(bytes: Buffer, offset: number): Buffer {
  const out = Buffer.from(bytes);
  out[offset] = (out[offset] ?? 0) ^ 0xff;
  return out;
}

// Matches an Anchor error by code, ignoring any extra fields Anchor may add over time.
function expectAnchorCode(code: string) {
  return expect.objectContaining({
    error: expect.objectContaining({
      errorCode: expect.objectContaining({ code }),
    }),
  });
}

describe("integration: happy path + arity", () => {
  it("1. preimage VK + valid proof → return data 0x01", async () => {
    const { returnData } = await runVerify(
      preimage.circuitId,
      preimage.proofBytes,
      preimage.publicInputs,
    );
    expect(returnData).not.toBeNull();
    expect(returnData!.length).toBe(1);
    expect(returnData![0]).toBe(0x01);
  });

  // A tampered proof returns 0x00, not an error. The program gives a verdict; it doesn't abort.
  it("2. preimage VK + tampered proof (flip byte in A) → return data 0x00", async () => {
    const tampered = flipByte(preimage.proofBytes, 5);
    const { returnData } = await runVerify(
      preimage.circuitId,
      tampered,
      preimage.publicInputs,
    );
    expect(returnData).not.toBeNull();
    expect(returnData![0]).toBe(0x00);
  });

  it("3. range VK + valid proof → return data 0x01", async () => {
    const { returnData } = await runVerify(
      range.circuitId,
      range.proofBytes,
      range.publicInputs,
    );
    expect(returnData).not.toBeNull();
    expect(returnData![0]).toBe(0x01);
  });

  it("4. range proof against preimage VK → ArityMismatch", async () => {
    await expect(
      runVerify(preimage.circuitId, range.proofBytes, range.publicInputs),
    ).rejects.toEqual(expectAnchorCode("ArityMismatch"));
  });
});

describe("integration: canonical + contract boundaries", () => {
  it("5. re-init same VK bytes → errors on existing PDA", async () => {
    await expect(initVk(preimage)).rejects.toThrow();
  });

  // Hash the bad bytes to get a circuit_id so the PDA seeds correctly and the program's strict parser is what rejects.
  it("6. non-canonical VK with trailing byte → NonCanonicalVk", async () => {
    const fresh = loadCircuit("preimage");
    const trailing = Buffer.concat([fresh.canonicalVk, Buffer.from([0])]);
    const badId = Buffer.from(canonicalVkHash(trailing));
    await expect(initVkRaw(badId, trailing)).rejects.toEqual(
      expectAnchorCode("NonCanonicalVk"),
    );
  });

  it("7. non-canonical VK with mismatched ic_len prefix → NonCanonicalVk", async () => {
    const fresh = loadCircuit("preimage");
    const mutated = Buffer.from(fresh.canonicalVk);
    // bump the u32 LE ic_len at offset 448 by +1 without extending the IC region
    mutated[448] = (mutated[448] ?? 0) + 1;
    const badId = Buffer.from(canonicalVkHash(mutated));
    await expect(initVkRaw(badId, mutated)).rejects.toEqual(
      expectAnchorCode("NonCanonicalVk"),
    );
  });

  // Confirms the client and program agree on the circuit_id, and the PDA exists and belongs to our program.
  it("8. client-computed circuit_id matches program-derived PDA", async () => {
    const clientId = canonicalVkHash(reshapeVk(preimage.vkJson));
    expect(Buffer.from(clientId).equals(preimage.circuitId)).toBe(true);

    const [pda] = vkPda(preimage.circuitId);
    const acct = await provider.connection.getAccountInfo(pda);
    expect(acct).not.toBeNull();
    expect(acct!.owner.toBase58()).toBe(program.programId.toBase58());
  });

  it("9. verify_proof on unknown circuit_id → AccountNotInitialized", async () => {
    const unknown = randomBytes(32);
    await expect(
      runVerify(unknown, preimage.proofBytes, preimage.publicInputs),
    ).rejects.toEqual(expectAnchorCode("AccountNotInitialized"));
  });

  it("10. truncated proof bytes → MalformedProof", async () => {
    const truncated = preimage.proofBytes.subarray(0, 255);
    await expect(
      runVerify(preimage.circuitId, truncated, preimage.publicInputs),
    ).rejects.toEqual(expectAnchorCode("MalformedProof"));
  });
});
