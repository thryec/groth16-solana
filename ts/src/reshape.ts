// converts snarkjs JSON (Groth16 VK + proof π) into canonical on-chain bytes — EIP-197 byte layout
import { createHash } from "node:crypto";

const BN254_P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// snarkjs vk shape — JSON form. Field elements are decimal strings; G2 is [c0, c1] (swapped on serialize).
export interface SnarkjsVk {
  protocol: string;
  curve: string;
  nPublic: number;
  vk_alpha_1: [string, string, string];
  vk_beta_2: [[string, string], [string, string], [string, string]];
  vk_gamma_2: [[string, string], [string, string], [string, string]];
  vk_delta_2: [[string, string], [string, string], [string, string]];
  IC: [string, string, string][];
}

export interface SnarkjsProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: string;
  curve: string;
}

// canonical on-chain byte widths
export const VK_ALPHA_LEN = 64;
export const VK_G2_LEN = 128;
export const VK_IC_POINT_LEN = 64;
export const VK_FIXED_PREFIX = VK_ALPHA_LEN + VK_G2_LEN * 3 + 4;
export const PROOF_LEN = 256;

// field element (F_q coord or F_r scalar) → 32-byte BE; snarkjs ships decimals, syscalls want bytes
export function bigintToBe32(value: string | bigint): Uint8Array {
  let n = typeof value === "string" ? BigInt(value) : value;
  if (n < 0n || n >= 1n << 256n) {
    throw new RangeError("field element out of 32-byte range");
  }
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

// G₁ point → 64 bytes (x ‖ y, BE). α, Ψᵢ live in VK; A, C live in proof. negateY flips A → -A so e(-A,B)·... = 1 holds.
function writeG1(
  out: Uint8Array,
  offset: number,
  point: readonly string[],
  negateY: boolean,
): void {
  const x = BigInt(point[0]!);
  const yRaw = BigInt(point[1]!);
  const y = negateY ? (BN254_P - (yRaw % BN254_P)) % BN254_P : yRaw; // (p-y) mod p in F_q for proof_a
  out.set(bigintToBe32(x), offset);
  out.set(bigintToBe32(y), offset + 32);
}

// G₂ point → 128 bytes. β, γ, δ live in VK; B lives in proof. Swap [c0, c1] → [c1, c0] per EIP-197 or syscall silently rejects.
function writeG2(
  out: Uint8Array,
  offset: number,
  point: readonly (readonly string[])[],
): void {
  const xc0 = BigInt(point[0]![0]!);
  const xc1 = BigInt(point[0]![1]!);
  const yc0 = BigInt(point[1]![0]!);
  const yc1 = BigInt(point[1]![1]!);
  out.set(bigintToBe32(xc1), offset);
  out.set(bigintToBe32(xc0), offset + 32);
  out.set(bigintToBe32(yc1), offset + 64);
  out.set(bigintToBe32(yc0), offset + 96);
}

// VK σ_V ([α]₁, [β]₂, [γ]₂, [δ]₂, IC) → canonical bytes for the on-chain PDA upload; sha256 of these = circuit_id
export function reshapeVk(vk: SnarkjsVk): Uint8Array {
  const icLen = vk.IC.length;
  const out = new Uint8Array(VK_FIXED_PREFIX + icLen * VK_IC_POINT_LEN);

  let off = 0;
  writeG1(out, off, vk.vk_alpha_1, false);
  off += VK_ALPHA_LEN;
  writeG2(out, off, vk.vk_beta_2);
  off += VK_G2_LEN;
  writeG2(out, off, vk.vk_gamma_2);
  off += VK_G2_LEN;
  writeG2(out, off, vk.vk_delta_2);
  off += VK_G2_LEN;

  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(
    off,
    icLen,
    true,
  );
  off += 4;

  for (const ic of vk.IC) {
    writeG1(out, off, ic, false);
    off += VK_IC_POINT_LEN;
  }
  return out;
}

// Groth16 proof π = ([A]₁, [B]₂, [C]₁) → 256 bytes. A pre-negated so e(-A,B)·e(α,β)·e(X,γ)·e(C,δ) = 1 collapses on-chain.
export function reshapeProof(proof: SnarkjsProof): Uint8Array {
  const out = new Uint8Array(PROOF_LEN);
  writeG1(out, 0, proof.pi_a, true);
  writeG2(out, 64, proof.pi_b);
  writeG1(out, 192, proof.pi_c, false);
  return out;
}

// public inputs (F_r scalars a₁..a_ℓ) → Vec<32-byte BE>. Verifier MSMs them against IC to compute [X]₁.
export function reshapePublicInputs(values: readonly string[]): Uint8Array[] {
  return values.map((v) => bigintToBe32(v));
}

// circuit_id = sha256(VK canonical bytes); content-addressed PDA seed, both client and program must hash identical bytes
export function canonicalVkHash(canonical: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(canonical).digest());
}
