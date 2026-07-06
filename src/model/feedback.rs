use serde::{Deserialize, Serialize};

// Category the user tags a piece of feedback with. Mirrors the dashboard's Type
// dropdown (see assets/js/home.js). `Other` is the fallback for anything the
// client sends that we don't recognise.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum FeedbackKind { Bug, Idea, Question, Other }
impl Default for FeedbackKind {
    fn default() -> Self { FeedbackKind::Other }
}
impl FeedbackKind {
    // Parse the free-form value the client sends, tolerating case. Anything
    // unrecognised becomes `Other` rather than a rejected request.
    pub fn parse(value: &str) -> Self {
        match value.trim().to_lowercase().as_str() {
            "bug" => FeedbackKind::Bug,
            "idea" => FeedbackKind::Idea,
            "question" => FeedbackKind::Question,
            _ => FeedbackKind::Other,
        }
    }
}
impl std::fmt::Display for FeedbackKind {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(fmt, "{:?}", self)
    }
}

// feedback — one message a user sent from the dashboard's Feedback page. Capped
// per user per calendar day (enforced server-side on create).
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Feedback {
    pub uuid: String,
    pub user_id: String,        // account uuid of the sender
    pub kind: FeedbackKind,
    pub message: String,
    pub created_at: i64,        // epoch millis
}
