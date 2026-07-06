use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::ProjectComment;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    resolved: bool,
}

// Resolve or reopen a comment thread. Any member with access may toggle it.
pub async fn task(
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let (project_id, comment_id) = path.into_inner();
    let db = MongoDB.connect();

    if let Err(response) = super::access(&db, &project_id, &user.user_id).await {
        return Ok(response);
    }

    let now = Utc::now().timestamp_millis();
    let result = db
        .collection::<ProjectComment>("project_comment")
        .update_one(
            doc! { "uuid": &comment_id, "project_id": &project_id },
            doc! { "$set": { "resolved": body.resolved, "modified_at": now } },
        )
        .await;

    match result {
        Ok(update) if update.matched_count == 0 => Ok(Response::not_found("Comment not found")),
        Ok(_) => Ok(Response::ok_message(if body.resolved { "Comment resolved" } else { "Comment reopened" })),
        Err(error) => {
            log::error!("{:?}", error);
            Ok(Response::internal_server_error(&error.to_string()))
        }
    }
}
