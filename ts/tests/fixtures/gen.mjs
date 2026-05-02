// Independent fixture generator: ffjavascript LE+reverse path, NOT reshape.ts.
// Two implementations agree iff byte layout is right; tautological fixtures wouldn't catch a shared bug.
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { utils } from "ffjavascript";

const { unstringifyBigInts, leInt2Buff } = utils;

const __dirname = dirname(fileURLToPath(import.meta.url));

const BN254_P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

function beBytes32(val) {
  const le = leInt2Buff(unstringifyBigInts(val), 32);
  return Buffer.from(le).reverse();
}

function encodeG1(point, negate) {
  const x = BigInt(point[0]);
  let y = BigInt(point[1]);
  if (negate) y = (BN254_P - (y % BN254_P)) % BN254_P; // (p-y) mod p in F_q for proof_a
  return Buffer.concat([beBytes32(x.toString()), beBytes32(y.toString())]);
}

// snarkjs [c0, c1] per Fq² coord pair -> EIP-197 [c1, c0]; swap on serialize.
function encodeG2(point) {
  const xc0 = point[0][0];
  const xc1 = point[0][1];
  const yc0 = point[1][0];
  const yc1 = point[1][1];
  return Buffer.concat([
    beBytes32(xc1),
    beBytes32(xc0),
    beBytes32(yc1),
    beBytes32(yc0),
  ]);
}

// Layout: α_G1 ‖ β_G2 ‖ γ_G2 ‖ δ_G2 ‖ u32_LE(|IC|) ‖ IC_points.
function reshapeVk(vk) {
  const icLen = vk.IC.length;
  const icBuf = Buffer.concat(vk.IC.map((p) => encodeG1(p, false)));
  const lenPrefix = Buffer.alloc(4);
  lenPrefix.writeUInt32LE(icLen, 0);
  return Buffer.concat([
    encodeG1(vk.vk_alpha_1, false),
    encodeG2(vk.vk_beta_2),
    encodeG2(vk.vk_gamma_2),
    encodeG2(vk.vk_delta_2),
    lenPrefix,
    icBuf,
  ]);
}

// Negated A (64) ‖ B (128) ‖ C (64).
function reshapeProof(proof) {
  return Buffer.concat([
    encodeG1(proof.pi_a, true),
    encodeG2(proof.pi_b),
    encodeG1(proof.pi_c, false),
  ]);
}

function reshapePublic(values) {
  return values.map((v) => beBytes32(v));
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

function build(circuit) {
  const dir = join(__dirname, circuit);
  const vk = JSON.parse(readFileSync(join(dir, "vk.json"), "utf8"));
  const proof = JSON.parse(readFileSync(join(dir, "proof.json"), "utf8"));
  const pub = JSON.parse(readFileSync(join(dir, "public.json"), "utf8"));

  const vkBytes = reshapeVk(vk);
  const proofBytes = reshapeProof(proof);
  const pubBytes = reshapePublic(pub);
  const vkHash = sha256(vkBytes);

  const out = {
    vkCanonicalHex: vkBytes.toString("hex"),
    vkHashHex: vkHash.toString("hex"),
    proofCanonicalHex: proofBytes.toString("hex"),
    publicInputsHex: pubBytes.map((b) => b.toString("hex")),
  };
  writeFileSync(join(dir, "expected.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(
    `${circuit}: vk=${vkBytes.length}B proof=${proofBytes.length}B pub=${pubBytes.length}x32B`,
  );
}

build("preimage");
build("range");
