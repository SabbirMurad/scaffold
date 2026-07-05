use serde::Deserialize;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::{ ProjectCollaborator, ProjectRole };
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    role: String, // "Viewer" | "Editor"
}

// Change a collaborator's role on a project. Owner only; ownership can't be
// reassigned here.
pub async fn task(
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let (project_id, invite_id) = path.into_inner();
    let db = MongoDB.connect();

    let (_core, role) = match super::access(&db, &project_id, &user.user_id).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    if role != ProjectRole::Owner {
        return Ok(Response::forbidden("Only the owner can change roles"));
    }

    let new_role = match body.role.trim().to_lowercase().as_str() {
        "viewer" => ProjectRole::Viewer,
        "editor" => ProjectRole::Editor,
        "owner" => return Ok(Response::bad_request("Ownership can't be reassigned")),
        _ => return Ok(Response::bad_request("Invalid role")),
    };

    let result = db
        .collection::<ProjectCollaborator>("project_collaborator")
        .update_one(
            doc! { "uuid": &invite_id, "project_id": &project_id },
            doc! { "$set": { "role": new_role.to_string() } },
        )
        .await;

    let update = match result {
        Ok(update) => update,
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    if update.matched_count == 0 {
        return Ok(Response::not_found("Collaborator not found"));
    }

    Ok(Response::ok_message("Role updated"))
}
