// Anchor program entrypoint — circuit-agnostic Groth16 verifier with two instructions:
// initialize_vk (write σ_V to a content-addressed PDA) and verify_proof (run the on-chain pairing check).
#![allow(clippy::diverging_sub_expression)] // false positive from #[program] macro expansion

mod errors;
mod state;
mod vendor; // forked groth16-solana; NR_INPUTS const generic removed for runtime arity
mod verify;

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::set_return_data;

pub use errors::VerifierError;
pub use state::VerifyingKey;

use verify::{compute_circuit_id, ic_len_hint, parse_canonical_vk, run_verify};

declare_id!("FyxYE2zo4NzYuQKiXiVfEFfVMHm69RNz4gwKNqws66VL");

#[program]
pub mod verifier {
    use super::*;

    // Writes σ_V (Groth16 verifying key) to a fresh content-addressed PDA. circuit_id is an arg
    // because PDA seeds resolve before the handler runs; we verify it matches sha256(canonical re-emit).
    pub fn initialize_vk(
        ctx: Context<InitializeVk>,
        circuit_id: [u8; 32],
        vk_bytes: Vec<u8>,
    ) -> Result<()> {
        let parsed = parse_canonical_vk(&vk_bytes)?;
        let derived_id = compute_circuit_id(&parsed); // hash re-emit, not raw bytes — trailing-byte attack would produce a duplicate circuit_id
        if derived_id != circuit_id {
            return err!(VerifierError::CircuitIdMismatch);
        }

        let vk = &mut ctx.accounts.vk;
        vk.alpha_g1 = parsed.alpha_g1;
        vk.beta_g2 = parsed.beta_g2;
        vk.gamma_g2 = parsed.gamma_g2;
        vk.delta_g2 = parsed.delta_g2;
        vk.ic = parsed.ic;
        Ok(())
    }

    // Runs the Groth16 pairing-product check against the stored σ_V; writes a single return byte
    // (0x01 verified / 0x00 rejected by circuit). System failures (malformed bytes, arity, missing VK) abort the tx.
    pub fn verify_proof(
        ctx: Context<VerifyProof>,
        _circuit_id: [u8; 32],
        proof_bytes: Vec<u8>,
        public_inputs: Vec<[u8; 32]>,
    ) -> Result<()> {
        let ok = run_verify(&ctx.accounts.vk, &proof_bytes, &public_inputs)?;
        set_return_data(&[u8::from(ok)]); // return byte = verdict (0x01/0x00); tx error = couldn't evaluate
        Ok(())
    }
}

// initialize_vk accounts: fresh PDA seeded [b"vk", circuit_id]. `init` errors on existing PDA —
// re-init is forbidden by design (VKs are immutable, no authority, no update path).
#[derive(Accounts)]
#[instruction(circuit_id: [u8; 32], vk_bytes: Vec<u8>)]
pub struct InitializeVk<'info> {
    #[account(
        init,
        payer = payer,
        space = VerifyingKey::space(ic_len_hint(&vk_bytes)),
        seeds = [b"vk", circuit_id.as_ref()],
        bump
    )]
    pub vk: Box<Account<'info, VerifyingKey>>, // Box: VK can exceed 1 KiB; avoids BPF stack overflow
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

// verify_proof accounts: PDA lookup only (no init, no writes). Missing PDA = unknown circuit_id,
// surfaces as Anchor's AccountNotInitialized — content-addressed PDAs give us this rejection for free.
#[derive(Accounts)]
#[instruction(circuit_id: [u8; 32])]
pub struct VerifyProof<'info> {
    #[account(seeds = [b"vk", circuit_id.as_ref()], bump)]
    pub vk: Box<Account<'info, VerifyingKey>>, // missing PDA -> AccountNotInitialized
}
