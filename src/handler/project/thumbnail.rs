use serde::Deserialize;
use mongodb::bson::{ doc, to_bson };
use crate::BuiltIns::image;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::{ AllowedImageType, ImageStruct };
use crate::Model::Project::{ ProjectCore, ProjectRole };
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// A thumbnail is a small picture; anything bigger is a mistake.
pub const MAX_BYTES: usize = 1024 * 1024;

#[derive(Debug, Deserialize)]
pub struct Query {
    // Fingerprint of the design the picture shows (see ProjectCore::thumbnail_sig).
    sig: String,
}

// Set the project's dashboard preview: the editor draws its screens into a small
// image and sends the bytes here. The previous preview is deleted, so a project
// only ever holds one. Requires editor access. Doesn't count as an edit — the
// card's "Edited …" time is left alone.
pub async fn task(
    req: HttpRequest,
    path: web::Path<String>,
    query: web::Query<Query>,
    body: web::Bytes,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
    let db = MongoDB.connect();

    let (core, role) = match super::access(&db, &project_id, &user.user_id).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };
    if super::role_rank(&role) < super::role_rank(&ProjectRole::Editor) {
        return Ok(Response::forbidden("You need edit access to change the preview"));
    }

    let sig = query.sig.trim();
    if sig.is_empty() || sig.len() > 64 {
        return Ok(Response::bad_request("Invalid preview signature"));
    }
    if body.is_empty() || body.len() > MAX_BYTES {
        return Ok(Response::bad_request("Preview image is empty or too large"));
    }

    let info = match image::add(&project_id, body.to_vec()).await {
        Ok(info) => info,
        Err(msg) => return Ok(Response::bad_request(&msg)),
    };
    let r#type = match info.mime.as_str() {
        "image/png" => AllowedImageType::Png,
        "image/jpeg" => AllowedImageType::Jpeg,
        "image/gif" => AllowedImageType::Gif,
        _ => AllowedImageType::Webp,
    };
    let thumb = ImageStruct { uuid: info.uuid.clone(), width: info.width, height: info.height, r#type };
    let thumb = match to_bson(&thumb) {
        Ok(value) => value,
        Err(error) => return Ok(Response::internal_server_error(&error.to_string())),
    };

    let result = db
        .collection::<ProjectCore>("project_core")
        .update_one(
            doc! { "uuid": &project_id },
            doc! { "$set": { "thumbnail_image": thumb, "thumbnail_sig": sig } },
        )
        .await;
    if let Err(error) = result {
        log::error!("{:?}", error);
        let _ = image::delete(&info.uuid).await;
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    // The old preview is unreachable now.
    if let Some(old) = core.thumbnail_image {
        if old.uuid != info.uuid {
            let _ = image::delete(&old.uuid).await;
        }
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(serde_json::json!({
        "uuid": info.uuid, "sig": sig,
    })))
}
