# groth16-solana

Reusable Groth16 verifier template for Solana. One deployed program verifies any Circom circuit — verifying keys live in content-addressed PDAs, no redeploy per circuit.

[Walkthrough →](writeup/)

## Contents

- Anchor program with `initialize_vk` and `verify_proof`
- `ts/src/reshape.ts` — snarkjs JSON → canonical on-chain bytes
- CLIs: `upload-vk.ts`, `verify.ts`
- Example circuits: `preimage` (1 input), `range` (2 inputs)
- 10 unit + 10 integration + 3 measurement tests

## Prerequisites

```bash
# Rust 1.89+
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Solana CLI 3.x
sh -c "$(curl -sSfL https://release.anza.xyz/stable/install)"

# Anchor 1.0
cargo install --git https://github.com/coral-xyz/anchor avm --locked
avm install latest && avm use latest

# Circom 2.2
cargo install --git https://github.com/iden3/circom.git circom

# pnpm + snarkjs (Node 24+ from nodejs.org)
npm install -g pnpm snarkjs
```

Local validator: [surfpool](https://github.com/solana-foundation/surfpool/releases) (or `solana-test-validator`).

## Quick start

```bash
git clone <repo-url> && cd groth16-solana
pnpm install
bash scripts/setup.sh
anchor build && anchor keys sync && anchor build
anchor test
bash scripts/example.sh
```

Expected output from `example.sh`:

```
[preimage] circuit_id=<64 hex chars>
verified: true
[range] circuit_id=<64 hex chars>
verified: true
```

## Bring your own circuit

Assume your circuit lives at `circuits/mycircuit/circuit.circom`.

**1. Compile and run Phase-2 ceremony.**

```bash
cd circuits/mycircuit
circom circuit.circom --r1cs --wasm --sym -l ../../node_modules/circomlib/circuits
snarkjs groth16 setup circuit.r1cs ~/.cache/ptau/powersOfTau28_hez_final_17.ptau circuit_0.zkey
echo "entropy" | snarkjs zkey contribute circuit_0.zkey circuit_final.zkey
snarkjs zkey export verificationkey circuit_final.zkey verification_key.json
```

**2. Generate witness and proof.**

```bash
node circuit_js/generate_witness.js circuit_js/circuit.wasm input.json witness.wtns
snarkjs groth16 prove circuit_final.zkey witness.wtns proof.json public.json
cd ../..
```

**3. Start a local validator and deploy.**

```bash
surfpool start &
until solana cluster-version >/dev/null 2>&1; do sleep 1; done
solana airdrop 100 && anchor deploy
```

**4. Upload the VK. Returns the content-addressed `circuit_id`.**

```bash
CID=$(pnpm -s exec tsx ts/src/upload-vk.ts --vk circuits/mycircuit/verification_key.json)
```

**5. Verify the proof on-chain.**

```bash
pnpm -s exec tsx ts/src/verify.ts --circuit-id "$CID" --proof circuits/mycircuit/proof.json --public circuits/mycircuit/public.json
```

One-shot upload ceiling is **4 public inputs** (see `artifacts/measurements.json`). Larger circuits require chunked upload (not implemented).

## Measurements

| Metric | Value |
|---|---|
| `verify_proof` CU (preimage) | 90,650 |
| `verify_proof` CU (range) | 95,979 |
| One-shot `initialize_vk` max public inputs | 4 |

## Attribution

`programs/verifier/src/vendor/` is vendored from [Lightprotocol/groth16-solana@54f2cfc3](https://github.com/Lightprotocol/groth16-solana/commit/54f2cfc3fd0f6d218e26384ee5d0f708c77883b7), modified only to remove the `NR_INPUTS` const generic. Upstream license at [`LICENSE-UPSTREAM`](LICENSE-UPSTREAM).

## License

MIT
