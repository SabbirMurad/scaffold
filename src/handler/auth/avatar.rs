use chrono::Utc;
use mongodb::bson::{ doc, to_bson, Bson };
use crate::BuiltIns::image;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::{ AllowedImageType, ImageStruct };
use crate::Model::Account::AccountProfile;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

pub const MAX_BYTES: usize = 2 * 1024 * 1024;

// Avatars live in the same image store as design images, under this scope
// instead of a project id. The image route serves them to any signed-in user.
pub const SCOPE_PREFIX: &str = "avatar:";

// Set the signed-in user's profile picture. The body is the raw image bytes; the
// format is validated from the bytes. The previous picture is deleted.
pub async fn upload(req: HttpRequest, body: web::Bytes) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;

    if body.is_empty() || body.len() > MAX_BYTES {
        return Ok(Response::bad_request("Image must be under 2MB"));
    }

    let scope = format!("{}{}", SCOPE_PREFIX, user.user_id);
    let info = match image::add(&scope, body.to_vec()).await {
        Ok(info) => info,
        Err(msg) => match msg.as_str() {
            "Unsupported image format!" | "Invalid image format!" | "Invalid image dimensions!" =>
                return Ok(Response::bad_request(&msg)),
            _ => return Ok(Response::internal_server_error(&msg)),
        },
    };
    let r#type = match info.mime.as_str() {
        "image/png" => AllowedImageType::Png,
        "image/jpeg" => AllowedImageType::Jpeg,
        "image/gif" => AllowedImageType::Gif,
        _ => AllowedImageType::Webp,
    };
    let picture = ImageStruct { uuid: info.uuid.clone(), width: info.width, height: info.height, r#type };
    let value = match to_bson(&picture) {
        Ok(value) => value,
        Err(error) => {
            let _ = image::delete(&info.uuid).await;
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let old = match set_picture(&user.user_id, value).await {
        Ok(old) => old,
        Err(response) => {
            let _ = image::delete(&info.uuid).await;
            return Ok(response);
        }
    };
    // The old picture is unreachable now.
    if let Some(old) = old {
        if old.uuid != info.uuid { let _ = image::delete(&old.uuid).await; }
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(serde_json::json!({
        "profile_picture": picture,
    })))
}

// Remove the signed-in user's profile picture (back to initials).
pub async fn remove(req: HttpRequest) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;

    match set_picture(&user.user_id, Bson::Null).await {
        Ok(old) => {
            if let Some(old) = old { let _ = image::delete(&old.uuid).await; }
            Ok(Response::ok_message("Profile picture removed"))
        }
        Err(response) => Ok(response),
    }
}

// Swap the profile's picture field, returning the one it replaced.
async fn set_picture(user_id: &str, value: Bson) -> Result<Option<ImageStruct>, HttpResponse> {
    let result = MongoDB.connect()
        .collection::<AccountProfile>("account_profile")
        .find_one_and_update(
            doc! { "uuid": user_id },
            doc! { "$set": {
                "profile_picture": value,
                "modified_at": Utc::now().timestamp_millis(),
            } },
        )
        .await;

    match result {
        Ok(Some(previous)) => Ok(previous.profile_picture),
        Ok(None) => Err(Response::not_found("Profile not found")),
        Err(error) => {
            log::error!("{:?}", error);
            Err(Response::internal_server_error(&error.to_string()))
        }
    }
}
