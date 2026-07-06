use crate::Handler;
use crate::BuiltIns::image;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// Serve a design image's bytes by id. Gated by project access: the caller must be
// a member (viewer or higher) of the project the image belongs to. Fetched by the
// editor with the bearer token — it can't be a plain <img src> because of that
// gate, so the frontend loads it via authenticated fetch and renders a blob URL.
pub async fn task(req: HttpRequest, path: web::Path<String>) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let image_id = path.into_inner();

    let stored = match image::get(&image_id).await {
        Ok(Some(image)) => image,
        Ok(None) => return Ok(Response::not_found("Image not found")),
        Err(msg) => return Ok(Response::internal_server_error(&msg)),
    };

    // Authorize against the image's owning project (404/403 on failure).
    let db = MongoDB.connect();
    if let Err(response) = Handler::Project::access(&db, &stored.project_id, &user.user_id).await {
        return Ok(response);
    }

    Ok(HttpResponse::Ok()
        .content_type(stored.mime.as_str())
        // Content is immutable (addressed by uuid) but access-gated, so keep it private.
        .append_header(("Cache-Control", "private, max-age=31536000, immutable"))
        .body(stored.bytes))
}
