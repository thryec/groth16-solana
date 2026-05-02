use anchor_lang::prelude::*;

// σ_V (Groth16 verifying key) — content-addressed PDA at [b"vk", circuit_id]. Immutable, no authority, no update path.
// Layout mirrors the canonical bytes ts/src/reshape.ts produces; G2 coords are in EIP-197 [c1, c0] order.
#[account]
pub struct VerifyingKey {
    pub alpha_g1: [u8; 64],   // [α]_1
    pub beta_g2: [u8; 128],   // [β]_2 — stored in EIP-197 [c1, c0] order (same for γ, δ below)
    pub gamma_g2: [u8; 128],  // [γ]_2 — public-input subspace separator
    pub delta_g2: [u8; 128],  // [δ]_2 — quotient/private subspace separator
    pub ic: Vec<[u8; 64]>,    // [Ψ_i]_1 array; length = nPublic + 1; ic[0] is the constant-1 term
}

impl VerifyingKey {
    pub const FIXED_SECTION: usize = 64 + 128 * 3 + 4; // alpha (64) + 3×G2 (128) + ic_len u32 (4)

    pub fn space(ic_len: usize) -> usize {
        8 + Self::FIXED_SECTION + ic_len * 64 // leading 8 = Anchor account discriminator
    }
}
