// Shared Anchor boot: provider, program, PDA derivation. Used by CLIs and tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import idl from "../../target/idl/verifier.json" with { type: "json" };
import type { Verifier } from "../../target/types/verifier.js";

export const PROGRAM_ID = new PublicKey(idl.address);
export const DEFAULT_CU_LIMIT = 400_000; // 4× over measured ~91k; cushion for future circuit growth

export function makeProvider(): AnchorProvider {
  const rpc = process.env.ANCHOR_PROVIDER_URL ?? "http://127.0.0.1:8899";
  const connection = new Connection(rpc, "confirmed");
  const walletPath =
    process.env.ANCHOR_WALLET ??
    join(process.env.HOME ?? "", ".config/solana/id.json");
  const secret = Uint8Array.from(
    JSON.parse(readFileSync(walletPath, "utf8")) as number[],
  );
  const payer = Keypair.fromSecretKey(secret);
  return new AnchorProvider(connection, new Wallet(payer), {
    commitment: "confirmed",
  });
}

export function makeProgram(provider: AnchorProvider): Program<Verifier> {
  return new Program<Verifier>(idl as Verifier, provider);
}

export function vkPda(circuitId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vk"), circuitId],
    PROGRAM_ID,
  );
}
