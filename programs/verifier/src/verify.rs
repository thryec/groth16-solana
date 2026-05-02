// On-chain Groth16 verifier glue — parse VK, re-emit, and verify orchestration over the verifier.
// Receives bytes already reshaped client-side by ts/src/reshape.ts; never sees snarkjs JSON.
use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

use crate::errors::VerifierError;
use crate::state::VerifyingKey;
use crate::vendor::{Groth16Error, Groth16Verifier, Groth16Verifyingkey};

// Canonical on-chain byte widths. Must match ts/src/reshape.ts; a drift here = silent on-chain rejections.
pub const ALPHA_LEN: usize = 64;
pub const G2_LEN: usize = 128;
pub const IC_POINT_LEN: usize = 64;
pub const IC_LEN_PREFIX: usize = 4;
pub const PROOF_LEN: usize = 256;

pub const IC_LEN_OFFSET: usize = ALPHA_LEN + G2_LEN * 3;
pub const IC_START_OFFSET: usize = IC_LEN_OFFSET + IC_LEN_PREFIX;

// Transient parse target for vk_bytes; identical layout to state::VerifyingKey but lives only during initialize_vk.
pub struct ParsedVk {
    pub alpha_g1: [u8; ALPHA_LEN],
    pub beta_g2: [u8; G2_LEN],
    pub gamma_g2: [u8; G2_LEN],
    pub delta_g2: [u8; G2_LEN],
    pub ic: Vec<[u8; IC_POINT_LEN]>,
}

// Cheap peek for Anchor's `init` constraint to size the account; returns 0 on too-short input so the strict parser rejects later.
pub fn ic_len_hint(bytes: &[u8]) -> usize {
    if bytes.len() < IC_START_OFFSET {
        return 0;
    }
    u32::from_le_bytes([
        bytes[IC_LEN_OFFSET],
        bytes[IC_LEN_OFFSET + 1],
        bytes[IC_LEN_OFFSET + 2],
        bytes[IC_LEN_OFFSET + 3],
    ]) as usize
}

// Strict layout parser: vk_bytes must exactly match σ_V layout α ‖ β ‖ γ ‖ δ ‖ u32_LE(ic_len) ‖ ic_len × G1.
// Any deviation (wrong length, trailing bytes, ic_len overflow) → NonCanonicalVk. Curve membership is not checked here — the syscall does that.
pub fn parse_canonical_vk(bytes: &[u8]) -> Result<ParsedVk> {
    if bytes.len() < IC_START_OFFSET {
        return err!(VerifierError::NonCanonicalVk);
    }
    let ic_len = ic_len_hint(bytes);
    let ic_region_len = ic_len
        .checked_mul(IC_POINT_LEN)
        .ok_or_else(|| error!(VerifierError::NonCanonicalVk))?;
    let expected_len = IC_START_OFFSET
        .checked_add(ic_region_len)
        .ok_or_else(|| error!(VerifierError::NonCanonicalVk))?;
    if bytes.len() != expected_len {
        return err!(VerifierError::NonCanonicalVk);
    }

    let alpha_g1: [u8; ALPHA_LEN] = bytes[0..ALPHA_LEN]
        .try_into()
        .map_err(|_| error!(VerifierError::NonCanonicalVk))?;
    let beta_g2: [u8; G2_LEN] = bytes[ALPHA_LEN..ALPHA_LEN + G2_LEN]
        .try_into()
        .map_err(|_| error!(VerifierError::NonCanonicalVk))?;
    let gamma_g2: [u8; G2_LEN] = bytes[ALPHA_LEN + G2_LEN..ALPHA_LEN + G2_LEN * 2]
        .try_into()
        .map_err(|_| error!(VerifierError::NonCanonicalVk))?;
    let delta_g2: [u8; G2_LEN] = bytes[ALPHA_LEN + G2_LEN * 2..ALPHA_LEN + G2_LEN * 3]
        .try_into()
        .map_err(|_| error!(VerifierError::NonCanonicalVk))?;

    let mut ic = Vec::with_capacity(ic_len);
    for i in 0..ic_len {
        let start = IC_START_OFFSET + i * IC_POINT_LEN;
        let point: [u8; IC_POINT_LEN] = bytes[start..start + IC_POINT_LEN]
            .try_into()
            .map_err(|_| error!(VerifierError::NonCanonicalVk))?;
        ic.push(point);
    }

    Ok(ParsedVk {
        alpha_g1,
        beta_g2,
        gamma_g2,
        delta_g2,
        ic,
    })
}

// Re-emit canonical bytes from parsed fields (NOT from raw vk_bytes) so trailing garbage past the parsed region
// can't produce a different circuit_id for a semantically-equal VK — preserves content-addressing.
pub fn canonical_reemit(parsed: &ParsedVk) -> Vec<u8> {
    let mut out = Vec::with_capacity(IC_START_OFFSET + parsed.ic.len() * IC_POINT_LEN);
    out.extend_from_slice(&parsed.alpha_g1);
    out.extend_from_slice(&parsed.beta_g2);
    out.extend_from_slice(&parsed.gamma_g2);
    out.extend_from_slice(&parsed.delta_g2);
    out.extend_from_slice(&(parsed.ic.len() as u32).to_le_bytes());
    for point in &parsed.ic {
        out.extend_from_slice(point);
    }
    out
}

// circuit_id = sha256(canonical re-emit); matches the client-side hash, so the PDA seed [b"vk", circuit_id] agrees on both sides.
pub fn compute_circuit_id(parsed: &ParsedVk) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(canonical_reemit(parsed));
    hasher.finalize().into()
}

// verify groth16 proof 
pub fn run_verify(
    vk: &VerifyingKey, // contains alpha, beta, gamma, delta + IC points (the original scalars are toxic waste, discarded)
    proof_bytes: &[u8], // 256-byte canonical proof
    public_inputs: &[[u8; 32]], // public inputs for the circuit (provided by the caller, not the verifier)
) -> Result<bool> {
    if public_inputs.len() + 1 != vk.ic.len() {
        return err!(VerifierError::ArityMismatch); // the VK has one IC point per public input plus one extra, reject if input count doesn't match
    }
    if proof_bytes.len() != PROOF_LEN {
        return err!(VerifierError::MalformedProof); // check if proof is correct length
    }

    // divides proof into 3 parts at canonical offsets 0 / 64 / 192 and checks each piece is the right length
    let proof_a: &[u8; 64] = proof_bytes[0..64]
        .try_into()
        .map_err(|_| error!(VerifierError::MalformedProof))?;
    let proof_b: &[u8; 128] = proof_bytes[64..192]
        .try_into()
        .map_err(|_| error!(VerifierError::MalformedProof))?;
    let proof_c: &[u8; 64] = proof_bytes[192..256]
        .try_into()
        .map_err(|_| error!(VerifierError::MalformedProof))?;

    // repackages our verifying key into the format expected by the light protocol verifier
    let vk_ref = Groth16Verifyingkey {
        nr_pubinputs: vk.ic.len(),
        vk_alpha_g1: vk.alpha_g1,
        vk_beta_g2: vk.beta_g2,
        vk_gamma_g2: vk.gamma_g2,
        vk_delta_g2: vk.delta_g2,
        vk_ic: &vk.ic,
    };

    let mut verifier = Groth16Verifier::new(proof_a, proof_b, proof_c, public_inputs, &vk_ref)
        .map_err(|e| match e {
            Groth16Error::InvalidPublicInputsLength => error!(VerifierError::ArityMismatch),
            _ => error!(VerifierError::MalformedProof),
        })?;

    // true if proof passes, false if it fails the crypto check (gets mapped to 0x01/0x00 later), error if anything else goes wrong
    match verifier.verify() {
        Ok(()) => Ok(true),
        Err(Groth16Error::ProofVerificationFailed) => Ok(false), // cryptographic verdict; everything else aborts
        Err(_) => err!(VerifierError::MalformedProof),
    }
}
