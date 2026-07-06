use crate::BuiltIns::image;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::ProjectRole;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// Upload a design image for a project. The bytes are stored in the SQLite image
// store (scoped to this project); the response carries the id the editor writes
// onto the image node as a reference. Requires editor access or higher.
//
// The body is the raw image bytes (the client sends the file/blob directly); the
// format is validated from the bytes, not any client-provided content type.
pub async fn task(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Bytes,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
    let db = MongoDB.connect();

    let (_core, role) = match super::access(&db, &project_id, &user.user_id).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    if super::role_rank(&role) < super::role_rank(&ProjectRole::Editor) {
        return Ok(Response::forbidden("You need edit access to add images"));
    }

    if body.is_empty() {
        return Ok(Response::bad_request("Empty image upload"));
    }

    match image::add(&project_id, body.to_vec()).await {
        Ok(info) => Ok(HttpResponse::Ok().content_type("application/json").json(info)),
        // Format/dimension failures are the caller's fault; anything else is ours.
        Err(msg) => match msg.as_str() {
            "Unsupported image format!" | "Invalid image format!" | "Invalid image dimensions!" =>
                Ok(Response::bad_request(&msg)),
            _ => Ok(Response::internal_server_error(&msg)),
        },
    }
}
