# Building a Circuit-Agnostic Groth16 Verifier on Solana

How a circuit-agnostic Groth16 verifier on Solana works: the on-chain program, the snarkjs → on-chain byte conversion, the trusted setup, and the content-addressed VK design.

---

## What this is

A **circuit-agnostic Groth16 verifier template** for Solana:

- One Anchor program, deployed once.
- Any Circom circuit's verifying key (VK) lives in its own content-addressed PDA.
- A new circuit means *uploading a VK*, not redeploying.

The verifier core is a vendored fork of [Lightprotocol/groth16-solana](https://github.com/Lightprotocol/groth16-solana). The only modification is removing a `NR_INPUTS` const generic that locked the verifier to compile-time-known public-input arity — runtime-sized public inputs are necessary for a multi-circuit template.

The rest of the work is converting snarkjs JSON into the exact bytes the on-chain verifier expects, hashing those bytes deterministically into a `circuit_id`, and storing the VK at a PDA derived from that hash. Errors in any of those steps cause the verifier to silently reject valid proofs.

---

## Verification equation

Groth16 is a zk-SNARK: short, non-interactive proofs that some private witness satisfies a public set of constraints, with verification cost independent of circuit size. The verification equation is a single product of four pairings:

```
e(-A, B) · e(α, β) · e(X, γ) · e(C, δ) = 1
```

Where:

- `(A, B, C)` is the **proof** — three elliptic-curve points produced by the prover. A and C are in G₁ (64 bytes each), B is in G₂ (128 bytes). Total: 256 bytes.
- `α, β, γ, δ` are commitments **baked into the verifying key** during trusted setup. They aren't scalars on the verifier's side — they're elliptic-curve points (`[α]₁`, `[β]₂`, `[γ]₂`, `[δ]₂`).
- `X` is the **public-input commitment**, computed by the verifier as `X = IC[0] + Σ aᵢ · IC[i+1]` where `IC` is an array of G₁ points (also from the VK) and `aᵢ` are the public input values.

Three things follow:

1. **Verifier work is constant in circuit size.** No matter whether the circuit has 213 constraints (the preimage example) or 213 thousand, the verifier runs the same four pairings plus an MSM whose length is the public input count.
2. **The verifying key is the entire on-chain footprint** of a circuit. A few hundred bytes regardless of circuit complexity. The proving key (which the prover uses) can be megabytes — but it stays off-chain.
3. **The four-pair structure means we get to use one batched pairing call.** Solana's `alt_bn128_pairing` syscall takes any number of (G₁, G₂) pairs and returns 1 if their pairing product equals 1. One syscall, one final exponentiation, one verdict.

The underlying primitive: `e(aP, bQ) = e(P, Q)^(a·b)`. Pairings allow checking multiplicative relations on hidden values, which is what the Groth16 verification equation rests on.

---

## Byte layout

snarkjs outputs `verification_key.json` and `proof.json` as JSON with decimal-string BigInt fields. Solana's BN254 syscalls expect raw 32-byte big-endian field elements with a specific G2 coordinate ordering. The conversion is mechanical, but every step has a way to silently produce a layout-valid but cryptographically wrong byte sequence that the syscall rejects without diagnostic.

Five places the conversion goes wrong:

### 1. G2 coordinate ordering

snarkjs serializes G2 points as `[c0, c1]` per coordinate (the Fq² element). The BN254 precompile convention used by Solana (and Ethereum's EIP-197) is `[c1, c0]`. **You must swap.** Per coordinate pair. For both `x` and `y`.

```js
// snarkjs:    [[x_c0, x_c1], [y_c0, y_c1]]
// on-chain:   [[x_c1, x_c0], [y_c1, y_c0]]
```

Skipping the swap returns `false` with no diagnostic. The proof is mathematically valid; the bytes are silently wrong.

### 2. The y-coordinate negation on `pi_a`

The Groth16 verification equation is `e(-A, B) · ... = 1`. The `-A` is a y-coordinate negation in G₁: if `A = (x, y)` then `-A = (x, p - y)` where `p` is the BN254 base field prime (`F_q`).

`alt_bn128_pairing` only checks `product = 1`; there is no equality mode. The negation happens client-side, in the reshape module, before the bytes are sent.

```js
// In F_q (the BN254 base field, NOT F_r the scalar field):
const BN254_P = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const negY = (BN254_P - y) % BN254_P;
```

Negating in `F_r` (the scalar field) instead of `F_q` produces an off-curve point and the syscall fails. F_q is for curve coordinates; F_r is for witness values. They are different primes.

### 3. Endianness mixed within the same struct

The canonical VK byte layout is:

```
α_G1 (64) ‖ β_G2 (128) ‖ γ_G2 (128) ‖ δ_G2 (128) ‖ u32_LE(|IC|) ‖ IC_points (64 × |IC|)
```

Field elements are big-endian. Length prefix is little-endian u32. The mismatch causes parsers to read the wrong number of IC points or reject on length.

### 4. The `ic_len` off-by-one

`IC` has `nPublic + 1` entries, not `nPublic`. The first entry (`IC[0]`) is the commitment to the always-1 wire that R1CS uses for constants — every circuit has one, and the verifier MSM uses it as the additive base case. `IC[1..]` correspond to actual public inputs.

Setting `ic_len = nPublic` (without the +1) causes the canonical-length check to reject the VK before it reaches the verifier.

### 5. Public input scalars must be < r

The public inputs are field elements in `F_r` (the scalar field, prime `r`, 254 bits). The syscall reads them as 256-bit integers, so any value in `[r, 2²⁵⁶)` gets implicitly reduced mod r — which means the prover's commitment X is computed against a different scalar than the verifier expects. Result: silent rejection.

The reshape module checks every public input against r before submission. The vendored verifier does it again on-chain (defense in depth).

---

## Trusted setup

The verifier needs the curve commitments `[α]₁`, `[β]₂`, `[γ]₂`, `[δ]₂` plus the IC array. These come from a trusted setup ceremony where one or more parties sample α, β, γ, δ as random scalars and commit to them. The scalars are then destroyed (the "toxic waste"); only the curve points survive in the verifying key.

If any scalar is retained, the holder can forge proofs against that VK.

In practice the ceremony has two phases:

- **Phase 1 — Powers of Tau** is universal: it produces a structured reference string of the form `[τⁱ]₁`, `[τⁱ]₂` for some secret τ. It's circuit-independent. Hermez/Polygon zkEVM ran a public Phase 1 ceremony with ~150 contributors; we use their output (`powersOfTau28_hez_final_17.ptau`, sized for circuits up to 2¹⁷ ≈ 131k constraints).
- **Phase 2 — circuit-specific** consumes the Phase 1 SRS and the circuit's R1CS, samples fresh α, β, γ, δ, and produces the proving key + verifying key. Production needs MPC across many parties (1-of-N honest-contributor model). The example circuits here use a single contributor via `snarkjs zkey contribute`.

Toxic-waste destruction is the load-bearing security assumption. Phase 1 universality is what makes Groth16 deployable at all: the expensive multi-party ceremony only happens once per curve, not once per circuit.

---

## The on-chain verifier

Solana exposes BN254 operations as **syscalls**, not as program code. There are three:

- `alt_bn128_addition` — adds two G₁ points.
- `alt_bn128_multiplication` — scalar-multiplies a G₁ point.
- `alt_bn128_pairing` — takes N (G₁, G₂) pairs and returns 1 if `Π e(Aᵢ, Bᵢ) = 1`, else 0.

These run as native validator code (Rust). Implementing pairings in BPF would exceed the compute-unit budget by orders of magnitude.

The verifier flow on-chain:

1. **Arity check** — `public_inputs.len() + 1 == vk.ic.len()`. Else return `ArityMismatch`.
2. **Slice the proof** — `A: 64 bytes | B: 128 bytes | C: 64 bytes`. Else `MalformedProof`.
3. **Compute the public-input commitment X** — `X = IC[0] + Σ aᵢ · IC[i+1]`. This is the G₁ MSM. The vendored verifier does it in a loop with `alt_bn128_multiplication` + `alt_bn128_addition`.
4. **Build the 4-pair input** — `(-A, B), (α, β), (X, γ), (C, δ)`. 768 bytes total (4 × 192).
5. **Call `alt_bn128_pairing`** — returns 32 bytes. Success = `[0; 31] || [1]`.
6. **Set return data** — `0x01` if the syscall returned success, `0x00` if the cryptographic check failed. Any other failure (malformed input, arity mismatch, syscall error) propagates as an Anchor error and aborts the transaction.

Step 6 distinguishes two failure modes:
- `0x00` return byte: the proof did not satisfy the circuit (cryptographic verdict).
- Transaction error: the system could not evaluate the proof (malformed bytes, missing VK, wrong arity).

Higher-level protocols built on this verifier need to distinguish "bad witness" from "bad client"; the return byte carries that distinction.

Measured cost: ~91k compute units per `verify_proof` call across both example circuits. Constant in circuit size, dominated by the pairing syscall.

---

## Content-addressed verifying keys

The PDA where each VK lives is seeded by `[b"vk", circuit_id]` where `circuit_id = sha256(canonical_vk_bytes)`. The storage address of a VK is a hash of the VK itself.

Properties:

- **Idempotent uploads.** Uploading the same VK twice produces the same `circuit_id` and lands at the same PDA. The second upload is a no-op (or, in the on-chain program, an "account already in use" error, which the CLI catches and treats as success).
- **Deduplication is automatic.** If two projects independently prove the same circuit, they share the on-chain VK. No coordination needed.
- **Permanent references.** A `circuit_id` published in a paper, a transaction, or another contract is forever — there's no admin who can rotate it.
- **No authority, no close, no update.** Mutability re-introduces griefing: a hostile authority could close the VK between when a caller derived `circuit_id` and when they submitted a proof. Immutability eliminates the entire class.

One non-obvious invariant: the program must re-emit canonical bytes from parsed VK fields and hash those, not the raw `vk_bytes` the client submitted. Otherwise an attacker can append a trailing `0x00` to a valid VK; if the strict parser is ever relaxed, hashing the raw input gives a different `circuit_id` than the canonical hash and creates a duplicate VK at a new PDA. Hashing the re-emitted form keeps the address invariant under client mangling.

---

## Bring your own circuit

The end-to-end flow for a new circuit, given the program is already deployed:

```bash
# 1. Compile + Phase-2 setup + proof generation
circom mycircuit.circom --r1cs --wasm --sym -l node_modules/circomlib/circuits
snarkjs groth16 setup mycircuit.r1cs ~/.cache/ptau/powersOfTau28_hez_final_17.ptau circuit_0.zkey
echo "entropy" | snarkjs zkey contribute circuit_0.zkey circuit_final.zkey
snarkjs zkey export verificationkey circuit_final.zkey verification_key.json

# 2. Witness + proof
node circuit_js/generate_witness.js circuit_js/circuit.wasm input.json witness.wtns
snarkjs groth16 prove circuit_final.zkey witness.wtns proof.json public.json

# 3. Off-chain sanity check (must pass before on-chain)
snarkjs groth16 verify verification_key.json public.json proof.json

# 4. Upload VK — prints circuit_id on stdout
CID=$(pnpm exec tsx ts/src/upload-vk.ts --vk verification_key.json)

# 5. Verify on-chain
pnpm exec tsx ts/src/verify.ts --circuit-id "$CID" --proof proof.json --public public.json
```

Per new circuit: the Circom source, the Phase-2 zkey, the witness inputs change.
Unchanged: the on-chain program, the reshape module, both CLIs, the PDA seed scheme.

The current ceiling is 4 public inputs per one-shot upload, measured against Solana's 1232-byte v0 transaction limit. Larger circuits require a chunked upload protocol, which is designed but not implemented in v1.

---

## Solana zk landscape

Solana's zk stack has three layers, in roughly decreasing maturity:

- **Token-2022 confidential transfers** — production. ZK-encrypted balances and transfers using ElGamal + range proofs, baked into a privileged precompile (`ZK ElGamal Proof Program`). Limited to that token-2022 use case.
- **Light Protocol / ZK Compression** — production. Compresses arbitrary state into Merkle trees with off-chain data availability + on-chain proofs. The verifier vendored here is from their stack.
- **Custom Groth16 verifiers** — what this template enables. Compile a Circom circuit, run Phase-2, upload the VK, verify proofs on-chain. Use cases: privacy primitives (commitment trees, nullifiers), credential systems, compliance proofs, ML inference attestation.

Lightprotocol/groth16-solana's published example hardcodes the VK into the program at compile time, which works for single-circuit deployments but not for templates. Three differences make this reusable: runtime-sized public inputs, content-addressed VK accounts, and an explicit reshape module.

---

## Future work

In rough priority:

1. **Chunked VK upload** — supports circuits with >4 public inputs. Designed but not implemented.
2. **Privacy app on top** — commitment tree + nullifier set + UI. The verifier alone is infrastructure; pairing it with protocol logic shows the full pattern.
3. **`snarkjs zkey export solanavk`** — an upstream snarkjs subcommand that emits canonical Solana bytes directly, the way `export solidityverifier` already does for Ethereum. Removes the reshape step from every downstream user.
4. **Halo2 backend** — same content-addressed structure, no pairings, no setup ceremony. Different curve, different bytes, same template skeleton.

---

## References

- [RareSkills' Groth16 series](https://rareskills.io/post/groth16) — Groth16 derivation.
- [Vitalik on QAPs](https://medium.com/@VitalikButerin/quadratic-arithmetic-programs-from-zero-to-hero-5f6f0f0a9f1c) — R1CS to QAP.
- [Groth16 paper (2016)](https://eprint.iacr.org/2016/260.pdf) — canonical reference.

MIT licensed.
