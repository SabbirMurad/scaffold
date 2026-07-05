use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::{ ProjectCollaborator, ProjectRole };
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// Remove a collaborator / invite. The owner can remove anyone; a collaborator
// can remove themselves (leave the project).
pub async fn task(
    req: HttpRequest,
    path: web::Path<(String, String)>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let (project_id, invite_id) = path.into_inner();
    let db = MongoDB.connect();

    let (_core, role) = match super::access(&db, &project_id, &user.user_id).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    let collaborator_collection = db.collection::<ProjectCollaborator>("project_collaborator");

    let invite = match collaborator_collection
        .find_one(doc! { "uuid": &invite_id, "project_id": &project_id })
        .await
    {
        Ok(Some(invite)) => invite,
        Ok(None) => return Ok(Response::not_found("Collaborator not found")),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let is_owner = role == ProjectRole::Owner;
    let is_self = invite.user_id.as_deref() == Some(user.user_id.as_str());

    if !is_owner && !is_self {
        return Ok(Response::forbidden("You can't remove this collaborator"));
    }

    if let Err(error) = collaborator_collection
        .delete_one(doc! { "uuid": &invite_id })
        .await
    {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(Response::ok_message("Collaborator removed"))
}
