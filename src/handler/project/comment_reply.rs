use uuid::Uuid;
use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::{ doc, to_bson };
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Model::Project::{ ProjectComment, CommentMessage };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

const MAX_TEXT_LEN: usize = 2000;

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    text: String,
}

// Append a reply to an existing thread. Any member with access may reply. Returns
// the updated thread.
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

    let text = body.text.trim().to_string();
    if text.is_empty() {
        return Ok(Response::bad_request("Comment cannot be empty"));
    }
    if text.chars().count() > MAX_TEXT_LEN {
        return Ok(Response::bad_request(&format!(
            "Comment must be within {} characters", MAX_TEXT_LEN
        )));
    }

    let now = Utc::now().timestamp_millis();
    let author_name = super::account_name(&db, &user.user_id).await;

    let message = CommentMessage {
        uuid: Uuid::now_v7().to_string(),
        author_id: user.user_id.clone(),
        author_name,
        text,
        created_at: now,
    };
    let message_bson = match to_bson(&message) {
        Ok(value) => value,
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let collection = db.collection::<ProjectComment>("project_comment");
    let result = collection
        .update_one(
            doc! { "uuid": &comment_id, "project_id": &project_id },
            doc! { "$push": { "messages": message_bson }, "$set": { "modified_at": now } },
        )
        .await;

    match result {
        Ok(update) if update.matched_count == 0 => {
            return Ok(Response::not_found("Comment not found"));
        }
        Ok(_) => {}
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    }

    // Return the fresh thread so the client can render the appended message.
    match collection
        .find_one(doc! { "uuid": &comment_id, "project_id": &project_id })
        .await
    {
        Ok(Some(comment)) => Ok(HttpResponse::Ok().content_type("application/json").json(comment)),
        Ok(None) => Ok(Response::not_found("Comment not found")),
        Err(error) => {
            log::error!("{:?}", error);
            Ok(Response::internal_server_error(&error.to_string()))
        }
    }
}
