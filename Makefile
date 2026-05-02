SHELL := /usr/bin/env bash
.SHELLFLAGS := -eu -o pipefail -c

REPO_ROOT := $(shell git rev-parse --show-toplevel)
RPC := http://127.0.0.1:8899
PTAU := $(HOME)/.cache/ptau/powersOfTau28_hez_final_17.ptau
INCLUDE := $(REPO_ROOT)/node_modules/circomlib/circuits

export ANCHOR_PROVIDER_URL := $(RPC)

.PHONY: help \
        bootstrap clean-circuits \
        inputs preimage range circuits \
        unit \
        validator deploy integration measurements view-measurements validator-stop \
        upload-vk-preimage verify-preimage upload-vk-range verify-range e2e \
        all

help:
	@echo "Targets, in step order:"
	@echo ""
	@echo "  bootstrap           install + anchor build + keys sync"
	@echo "  clean-circuits      wipe circuit build artifacts (keep .circom + input.json)"
	@echo ""
	@echo "Step 1 — trusted setup + proofs"
	@echo "  preimage            full off-chain pipeline for preimage circuit"
	@echo "  range               full off-chain pipeline for range circuit"
	@echo "  circuits            preimage + range"
	@echo ""
	@echo "Step 2 — reshape unit tests"
	@echo "  unit                pnpm test (reshape fixtures)"
	@echo ""
	@echo "Step 3 — on-chain verification"
	@echo "  validator           kill stale surfpool + start fresh + wait for RPC"
	@echo "  deploy              airdrop + anchor deploy"
	@echo "  integration         10 integration tests"
	@echo "  measurements        CU + tx-size measurements"
	@echo "  view-measurements   cat artifacts/measurements.json"
	@echo "  validator-stop      kill running surfpool"
	@echo ""
	@echo "Step 4 — end-to-end CLI"
	@echo "  upload-vk-preimage  upload preimage VK, print + cache circuit_id"
	@echo "  verify-preimage     verify preimage proof on-chain"
	@echo "  upload-vk-range     upload range VK"
	@echo "  verify-range        verify range proof on-chain"
	@echo "  e2e                 both circuits, upload + verify"
	@echo ""
	@echo "  all                 full pipeline end-to-end"

# === Bootstrap ===

bootstrap:
	@echo "→ pnpm install"
	pnpm install
	@echo "→ anchor build && anchor keys sync && anchor build (first-clone key alignment)"
	anchor build && anchor keys sync && anchor build

clean-circuits:
	@echo "→ wipe circuit build artifacts (keep circuit.circom + input.json)"
	rm -rf circuits/preimage/circuit_js circuits/preimage/circuit.r1cs \
	    circuits/preimage/circuit.sym circuits/preimage/circuit_*.zkey \
	    circuits/preimage/witness.wtns circuits/preimage/proof.json \
	    circuits/preimage/public.json circuits/preimage/verification_key.json
	rm -rf circuits/range/circuit_js circuits/range/circuit.r1cs \
	    circuits/range/circuit.sym circuits/range/circuit_*.zkey \
	    circuits/range/witness.wtns circuits/range/proof.json \
	    circuits/range/public.json circuits/range/verification_key.json

# === Step 1: Trusted setup + proofs ===

inputs:
	@echo "→ generate deterministic witness inputs (Poseidon(seed) for preimage; {x,min,max} for range)"
	node scripts/gen-inputs.mjs

# Shared recipe for both circuits — pattern rule, $@ is the target name.
preimage range: inputs
	@echo ""
	@echo "=== $@ circuit ==="
	@echo "→ circom $@/circuit.circom → R1CS + WASM + sym"
	cd circuits/$@ && circom circuit.circom --r1cs --wasm --sym -l $(INCLUDE)
	@echo "→ snarkjs r1cs info (constraint count + arity)"
	cd circuits/$@ && snarkjs r1cs info circuit.r1cs
	@echo "→ shim circuit_js/ as commonjs (root pkg.json is ESM)"
	printf '{"type":"commonjs"}\n' > circuits/$@/circuit_js/package.json
	@echo "→ snarkjs groth16 setup (Phase-2 init zkey from R1CS + ptau)"
	cd circuits/$@ && snarkjs groth16 setup circuit.r1cs $(PTAU) circuit_0.zkey
	@echo "→ snarkjs zkey contribute (single-contributor Phase-2)"
	cd circuits/$@ && echo "entropy-$@-$$(date +%s%N)" | \
	    snarkjs zkey contribute circuit_0.zkey circuit_final.zkey \
	        --name="contributor-$@" -v
	@echo "→ snarkjs zkey export verificationkey → verification_key.json"
	cd circuits/$@ && snarkjs zkey export verificationkey circuit_final.zkey verification_key.json
	@echo "→ generate_witness.js → witness.wtns"
	cd circuits/$@ && node circuit_js/generate_witness.js circuit_js/circuit.wasm input.json witness.wtns
	@echo "→ snarkjs groth16 prove → proof.json + public.json"
	cd circuits/$@ && snarkjs groth16 prove circuit_final.zkey witness.wtns proof.json public.json
	@echo "→ snarkjs groth16 verify (off-chain sanity gate — must pass before on-chain)"
	cd circuits/$@ && snarkjs groth16 verify verification_key.json public.json proof.json

circuits: preimage range

# === Step 2: Reshape unit tests ===

unit:
	@echo "→ pnpm test (reshape.ts fixtures)"
	pnpm test

# === Step 3: On-chain verification ===

validator:
	@echo "→ kill any stale surfpool on 8899"
	-lsof -tiTCP:8899 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true
	@sleep 1
	@echo "→ start surfpool detached (logs to /tmp/surfpool.log)"
	nohup surfpool start </dev/null >/tmp/surfpool.log 2>&1 &
	@echo "→ wait for RPC at $(RPC)"
	@until solana cluster-version --url $(RPC) >/dev/null 2>&1; do sleep 1; done
	@echo "  RPC live"

deploy:
	@echo "→ solana airdrop 100"
	solana airdrop 100 --url $(RPC) >/dev/null
	@echo "→ anchor deploy"
	anchor deploy 2>&1 | tail -5

integration:
	@echo "→ 10 integration tests"
	pnpm exec vitest run -c tests/vitest.config.ts tests/integration.test.ts

measurements:
	@echo "→ CU + tx-size measurements"
	pnpm exec vitest run -c tests/vitest.config.ts tests/measurements.test.ts

view-measurements:
	@echo "→ artifacts/measurements.json"
	cat artifacts/measurements.json

validator-stop:
	@echo "→ kill surfpool on 8899"
	-lsof -tiTCP:8899 -sTCP:LISTEN | xargs kill -9 2>/dev/null || true

# === Step 4: End-to-end CLI ===

upload-vk-preimage:
	@mkdir -p .circuit-ids
	@echo "→ upload preimage VK"
	@CID=$$(pnpm -s exec tsx ts/src/upload-vk.ts --vk circuits/preimage/verification_key.json) && \
	    echo "preimage circuit_id=$$CID" && \
	    echo "$$CID" > .circuit-ids/preimage

verify-preimage:
	@CID=$$(cat .circuit-ids/preimage) && \
	    echo "→ verify preimage (circuit_id=$$CID)" && \
	    pnpm -s exec tsx ts/src/verify.ts \
	        --circuit-id "$$CID" \
	        --proof circuits/preimage/proof.json \
	        --public circuits/preimage/public.json

upload-vk-range:
	@mkdir -p .circuit-ids
	@echo "→ upload range VK"
	@CID=$$(pnpm -s exec tsx ts/src/upload-vk.ts --vk circuits/range/verification_key.json) && \
	    echo "range circuit_id=$$CID" && \
	    echo "$$CID" > .circuit-ids/range

verify-range:
	@CID=$$(cat .circuit-ids/range) && \
	    echo "→ verify range (circuit_id=$$CID)" && \
	    pnpm -s exec tsx ts/src/verify.ts \
	        --circuit-id "$$CID" \
	        --proof circuits/range/proof.json \
	        --public circuits/range/public.json

e2e: upload-vk-preimage verify-preimage upload-vk-range verify-range

# === Full pipeline ===

all: clean-circuits circuits unit validator deploy integration measurements view-measurements e2e validator-stop
