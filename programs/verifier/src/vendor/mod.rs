#![allow(dead_code)]
// Upstream errors.rs uses `cfg(feature = "circom")` on variants that depend on
// arkworks serialization; we never enable the circom feature, so those bits
// compile out — but they must still be recognized as a known cfg value.
#![allow(unexpected_cfgs)]

pub mod errors;
pub mod groth16;

pub use errors::Groth16Error;
pub use groth16::{Groth16Verifier, Groth16Verifyingkey};
