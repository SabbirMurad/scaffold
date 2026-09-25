/*
  Design-image store. Raw image bytes are kept in the SQLite image DB; the Mongo
  design document only holds a reference (the returned uuid). Each row is scoped to
  a project so the serve endpoint can gate access by project membership.
*/

use uuid::Uuid;
use chrono::Utc;
use crate::builtins::sqlite;
use rusqlite::params;
use serde::{ Serialize, Deserialize };
use crate::Model::AllowedImageType;

// What the upload endpoint returns to the editor: the id it should store on the
// image node (as a reference), plus the decoded dimensions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageInfo {
    pub uuid: String,
    pub width: usize,
    pub height: usize,
    pub mime: String,
}

// A stored image loaded back out for serving.
#[derive(Debug, Clone)]
pub struct StoredImage {
    pub project_id: String,
    pub mime: String,
    pub bytes: Vec<u8>,
}

// Validate + store an image's bytes under a project, returning its reference info.
pub async fn add(project_id: &str, data: Vec<u8>) -> Result<ImageInfo, String> {
    // Validate the format from the bytes themselves (don't trust a client header).
    let image_type = get_image_format(&data)?;
    let img_size = get_image_size(&data)?;

    let db_conn = sqlite::connect(sqlite::DBF::IMG).map_err(|error| {
        log::error!("{:?}", error);
        "Image store unavailable".to_string()
    })?;

    let uuid = Uuid::now_v7().to_string();
    let mime = image_type.to_string();

    let result = db_conn.execute(
        "INSERT INTO image (uuid, project_id, mime, bytes, width, height, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![
            &uuid,
            project_id,
            &mime,
            &data,
            &img_size.width,
            &img_size.height,
            Utc::now().timestamp_millis(),
        ],
    );

    if let Err(error) = result {
        log::error!("{:?}", error);
        return Err(error.to_string());
    }

    Ok(ImageInfo { uuid, width: img_size.width, height: img_size.height, mime })
}

// Load an image by id for serving. `Ok(None)` means no such image.
pub async fn get(uuid: &str) -> Result<Option<StoredImage>, String> {
    let db_conn = sqlite::connect(sqlite::DBF::IMG).map_err(|error| {
        log::error!("{:?}", error);
        "Image store unavailable".to_string()
    })?;

    let mut stmt = db_conn
        .prepare("SELECT project_id, mime, bytes FROM image WHERE uuid = ?1")
        .map_err(|error| {
            log::error!("{:?}", error);
            error.to_string()
        })?;

    let mut rows = stmt
        .query_map(params![uuid], |row| {
            Ok(StoredImage {
                project_id: row.get(0)?,
                mime: row.get(1)?,
                bytes: row.get(2)?,
            })
        })
        .map_err(|error| {
            log::error!("{:?}", error);
            error.to_string()
        })?;

    match rows.next() {
        Some(Ok(image)) => Ok(Some(image)),
        Some(Err(error)) => {
            log::error!("{:?}", error);
            Err(error.to_string())
        }
        None => Ok(None),
    }
}

// Remove an image by id (e.g. a project thumbnail that has been replaced).
pub async fn delete(uuid: &str) -> Result<(), String> {
    let db_conn = sqlite::connect(sqlite::DBF::IMG).map_err(|error| {
        log::error!("{:?}", error);
        "Image store unavailable".to_string()
    })?;
    db_conn
        .execute("DELETE FROM image WHERE uuid = ?1", params![uuid])
        .map_err(|error| {
            log::error!("{:?}", error);
            error.to_string()
        })?;
    Ok(())
}

/* Validates image format based on image blob data */
fn get_image_format(data: &Vec<u8>) -> Result<AllowedImageType, String> {
    if let Some(image_type) = imghdr::from_bytes(data) {
        match image_type {
            imghdr::Type::Gif => Ok(AllowedImageType::Gif),
            imghdr::Type::Png => Ok(AllowedImageType::Png),
            imghdr::Type::Jpeg => Ok(AllowedImageType::Jpeg),
            imghdr::Type::Webp => Ok(AllowedImageType::Webp),
            _ => Err("Unsupported image format!".to_string()),
        }
    } else {
        Err("Invalid image format!".to_string())
    }
}

#[derive(Debug, Clone)]
struct ImageSize { width: usize, height: usize }

/* Extracts image dimension from image blob data */
fn get_image_size(data: &Vec<u8>) -> Result<ImageSize, String> {
    match imagesize::blob_size(data) {
        Ok(size) => Ok(ImageSize { width: size.width, height: size.height }),
        Err(error) => {
            log::error!("{:?}", error);
            Err("Invalid image dimensions!".to_string())
        }
    }
}
