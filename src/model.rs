use serde::{Deserialize, Serialize};

pub mod account;
pub use account as Account;

pub mod project;
pub use project as Project;

pub mod feedback;
pub use feedback as Feedback;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AllowedImageType { Gif, Png, Jpeg, Webp }

impl std::fmt::Display for AllowedImageType {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        match self {
            AllowedImageType::Gif => write!(fmt, "image/gif"),
            AllowedImageType::Png => write!(fmt, "image/png"),
            AllowedImageType::Jpeg => write!(fmt, "image/jpeg"),
            AllowedImageType::Webp => write!(fmt, "image/webp"),
        }
    }
}

#[derive(Debug, Deserialize, Serialize, Clone)]
pub struct ImageStruct {
  pub uuid: String,
  pub height: usize,
  pub width: usize,
  pub r#type: AllowedImageType
}