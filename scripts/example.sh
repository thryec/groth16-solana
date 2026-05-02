#!/usr/bin/env bash
# End-to-end example: every command from circom compile to on-chain verify,
# shown explicitly. Self-contained — does not depend on setup.sh having run.
# Adapt these commands when bringing your own circuit.
#
# Uses surfpool as the local simnet (faster startup than solana-test-validator
# and avoids the gossip-port conflict with some IDE services). RPC stays on 8899
# either way — swap `surfpool start` for `solana-test-validator` if preferred.
set -euo pipefail

# 1. Anchor to repo root so paths resolve from any cwd.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

RPC="http://127.0.0.1:8899"
PTAU_CACHE="$HOME/.cache/ptau"
PTAU_FILE="$PTAU_CACHE/powersOfTau28_hez_final_17.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau"
INCLUDE_PATH="$REPO_ROOT/node_modules/circomlib/circuits"

# 2. Pre-flight: every external tool we shell out to. Fail fast with helpful
#    messages instead of cryptic errors deep in the pipeline.
for cmd in circom snarkjs node pnpm solana anchor surfpool; do
    command -v "$cmd" >/dev/null 2>&1 || {
        echo "error: '$cmd' not found on PATH." >&2
        if [[ "$cmd" == "surfpool" ]]; then
            echo "install from https://github.com/solana-foundation/surfpool/releases" >&2
            echo "or swap this script's validator to solana-test-validator" >&2
        fi
        exit 1
    }
done

# === Off-chain: compile circuits, run trusted setup, generate proofs ===

# 3. Cache the powers-of-tau file (~145 MB) outside the repo. This is the
#    output of the universal phase-1 ceremony; reused across all circuits.
mkdir -p "$PTAU_CACHE"
if [[ ! -f "$PTAU_FILE" ]]; then
    echo "[ptau] downloading $PTAU_URL"
    curl -fL --retry 3 -o "$PTAU_FILE" "$PTAU_URL"
fi

# 4. Generate deterministic witness inputs. For preimage this computes
#    Poseidon(5) using circomlibjs (must match poseidon.circom on-chain);
#    for range it hardcodes {x: 42, min: 10, max: 100}.
node "$REPO_ROOT/scripts/gen-inputs.mjs"

# 5. Per-circuit off-chain pipeline: compile → setup → contribute → export
#    → witness → prove → sanity-verify.
for c in preimage range; do
    cd "$REPO_ROOT/circuits/$c"

    # 5a. Clean previous artifacts so the build is reproducible.
    rm -rf circuit_js circuit.r1cs circuit.sym circuit_0.zkey circuit_final.zkey \
        verification_key.json witness.wtns proof.json public.json

    # 5b. Compile .circom -> R1CS + WASM witness generator + symbol map.
    circom circuit.circom --r1cs --wasm --sym -l "$INCLUDE_PATH" -o .

    # 5c. circom emits CommonJS in circuit_js/, but root package.json sets
    #     "type":"module"; shim per-directory so generate_witness.js can require().
    printf '{"type":"commonjs"}\n' > circuit_js/package.json

    # 5d. Phase-2 trusted setup: derive the initial circuit-specific zkey.
    snarkjs groth16 setup circuit.r1cs "$PTAU_FILE" circuit_0.zkey

    # 5e. Single-contributor phase-2 contribution. Production needs MPC across
    #     many independent contributors; one is enough for a local example.
    echo "entropy-$c-$(date +%s%N)" | \
        snarkjs zkey contribute circuit_0.zkey circuit_final.zkey \
            --name="contributor-$c" -v >/dev/null

    # 5f. Extract the public verifying key from the finalized zkey.
    snarkjs zkey export verificationkey circuit_final.zkey verification_key.json

    # 5g. Compute the witness from the input + WASM, then generate the proof.
    node circuit_js/generate_witness.js circuit_js/circuit.wasm input.json witness.wtns
    snarkjs groth16 prove circuit_final.zkey witness.wtns proof.json public.json

    # 5h. Sanity gate: snarkjs's own verifier must accept before we even try
    #     on-chain. If this fails, the proof is malformed and on-chain will too.
    snarkjs groth16 verify verification_key.json public.json proof.json

    cd "$REPO_ROOT"
done

# === On-chain: validator, deploy, upload VK, verify proof ===

# 6. Start simnet in background; trap ensures cleanup on any exit path.
surfpool start >/tmp/surfpool.log 2>&1 &
VALIDATOR=$!
trap 'kill "$VALIDATOR" 2>/dev/null || true' EXIT

# 7. Poll until RPC is live.
until solana cluster-version --url "$RPC" >/dev/null 2>&1; do
    sleep 1
done

# 8. Fund wallet + deploy program. `tail -5` keeps routine output quiet while
#    still surfacing deploy failure logs; `pipefail` propagates the exit code.
solana airdrop 100 --url "$RPC" >/dev/null
anchor deploy 2>&1 | tail -5

# 9. Point CLIs at the local RPC.
export ANCHOR_PROVIDER_URL="$RPC"
mkdir -p .circuit-ids

# 10. Per circuit: upload VK to a content-addressed PDA, capture the
#     circuit_id, verify the proof on-chain. set -e propagates verify.ts's
#     exit code (0 verified, 1 not verified, 2 instruction error).
for c in preimage range; do
    CID=$(pnpm -s exec tsx ts/src/upload-vk.ts \
        --vk "circuits/$c/verification_key.json")
    echo "$CID" > ".circuit-ids/$c"
    echo "[$c] circuit_id=$CID"
    pnpm -s exec tsx ts/src/verify.ts \
        --circuit-id "$CID" \
        --proof "circuits/$c/proof.json" \
        --public "circuits/$c/public.json"
done
