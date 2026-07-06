use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::{ ProjectComment, ProjectRole };
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// Delete a comment thread. Restricted to the project owner.
pub async fn task(req: HttpRequest, path: web::Path<(String, String)>) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let (project_id, comment_id) = path.into_inner();
    let db = MongoDB.connect();

    let (_core, role) = match super::access(&db, &project_id, &user.user_id).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    if role != ProjectRole::Owner {
        return Ok(Response::forbidden("Only the project owner can delete comments"));
    }

    let result = db
        .collection::<ProjectComment>("project_comment")
        .delete_one(doc! { "uuid": &comment_id, "project_id": &project_id })
        .await;

    match result {
        Ok(deleted) if deleted.deleted_count == 0 => Ok(Response::not_found("Comment not found")),
        Ok(_) => Ok(Response::ok_message("Comment deleted")),
        Err(error) => {
            log::error!("{:?}", error);
            Ok(Response::internal_server_error(&error.to_string()))
        }
    }
}
