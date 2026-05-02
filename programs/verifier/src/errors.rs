use anchor_lang::prelude::*;

// Closed VerifierError set — every fallible path in this crate maps to exactly one variant.
// All four mean "system couldn't evaluate" and abort the tx; the rejected-by-circuit verdict is encoded as the 0x00 return byte from verify_proof.
#[error_code]
pub enum VerifierError {
    #[msg("vk_bytes failed canonical layout check")]
    NonCanonicalVk,
    #[msg("sha256(canonical_reemit(vk_bytes)) does not match claimed circuit_id")]
    CircuitIdMismatch,
    #[msg("public_inputs.len() + 1 must equal vk.ic.len()")]
    ArityMismatch,
    #[msg("proof bytes malformed or verification path errored")]
    MalformedProof,
}
