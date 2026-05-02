#!/usr/bin/env bash
# Phase-2 trusted setup + proof generation for both example circuits.
# Idempotent: caches ptau at ~/.cache/ptau and regenerates artifacts on every run.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PTAU_CACHE="${HOME}/.cache/ptau"
PTAU_FILE="${PTAU_CACHE}/powersOfTau28_hez_final_17.ptau"
PTAU_URL="https://storage.googleapis.com/zkevm/ptau/powersOfTau28_hez_final_17.ptau"

mkdir -p "$PTAU_CACHE"
if [[ ! -f "$PTAU_FILE" ]]; then
    echo "[ptau] downloading ($PTAU_URL)..."
    curl -fL --retry 3 -o "$PTAU_FILE" "$PTAU_URL"
fi

INCLUDE_PATH="$REPO_ROOT/node_modules/circomlib/circuits"

echo "[inputs] generating deterministic inputs..."
node "$REPO_ROOT/scripts/gen-inputs.mjs"

build_circuit() {
    local name="$1"
    local dir="$REPO_ROOT/circuits/$name"
    cd "$dir"

    rm -rf circuit_js circuit.r1cs circuit.sym circuit_0.zkey circuit_final.zkey \
        verification_key.json witness.wtns proof.json public.json

    echo "[$name] circom compile..."
    circom circuit.circom --r1cs --wasm --sym -l "$INCLUDE_PATH" -o .

    # circom's generate_witness.js uses require(); root package.json sets
    # "type": "module", so shim this subtree back to CommonJS.
    printf '{"type":"commonjs"}\n' > circuit_js/package.json

    echo "[$name] groth16 phase-2 setup..."
    snarkjs groth16 setup circuit.r1cs "$PTAU_FILE" circuit_0.zkey
    echo "entropy-$name-$(date +%s%N)" | \
        snarkjs zkey contribute circuit_0.zkey circuit_final.zkey \
            --name="contributor-$name" -v >/dev/null
    snarkjs zkey export verificationkey circuit_final.zkey verification_key.json

    echo "[$name] witness + proof..."
    node circuit_js/generate_witness.js circuit_js/circuit.wasm input.json witness.wtns
    snarkjs groth16 prove circuit_final.zkey witness.wtns proof.json public.json

    echo "[$name] snarkjs sanity verify..."
    snarkjs groth16 verify verification_key.json public.json proof.json

    cd "$REPO_ROOT"
}

build_circuit preimage
build_circuit range

echo "[setup] OK"
