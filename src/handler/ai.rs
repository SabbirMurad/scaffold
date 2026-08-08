// AI features (Claude). There's no official Anthropic Rust SDK, so these handlers
// proxy the Messages API over raw HTTP (reqwest); the API key stays server-side.

pub mod generate;
pub use generate as Generate;
