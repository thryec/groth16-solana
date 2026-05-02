// prover-side, generates deterministic inputs for the circuits we want to prove 
// verifier doesn't and will never know the private values defined here
// writes both secret and public claim to input.json needed to generate the proof for verification
// private inputs (preimage, x) never leave the prover's machine in actual production
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const poseidon = await buildPoseidon();
const F = poseidon.F;

const FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n; // BN254 scalar field order

const preimageSeed = createHash("sha256")
  .update("groth16-solana-preimage") // input for preimage circuit; high-entropy seed avoids brute-force attacks
  .digest("hex");
const preimage = BigInt("0x" + preimageSeed) % FR; // take modulus of Fr so preimage stays a valid field element
const hashField = poseidon([preimage]);
const hash = F.toObject(hashField).toString();

// 1. poseidon hash circuit 
writeFileSync(
  join(root, "circuits", "preimage", "input.json"),
  JSON.stringify({ preimage: preimage.toString(), hash }, null, 2) + "\n",
);

// 2. range circuit 
writeFileSync(
  join(root, "circuits", "range", "input.json"),
  JSON.stringify({ x: "42", min: "10", max: "100" }, null, 2) + "\n",
);

console.log("inputs written");
