use chrono::Utc;

pub mod create;
pub use create as Create;

pub mod list;
pub use list as List;

// Most feedback messages a single user may send in one calendar day. Enforced on
// create and surfaced to the dashboard so it can disable the form when reached.
pub const MAX_PER_DAY: i64 = 5;

// Longest a feedback message may be, matching the textarea's maxlength.
pub const MAX_MESSAGE_LEN: usize = 1000;

// Epoch-millis of the most recent UTC midnight. Unix time has no leap seconds, so
// a UTC day boundary always falls on an exact multiple of 86_400_000 ms — the
// daily cap counts submissions with created_at >= this.
pub fn start_of_utc_day_ms() -> i64 {
    const DAY_MS: i64 = 86_400_000;
    let now = Utc::now().timestamp_millis();
    now - now.rem_euclid(DAY_MS)
}
