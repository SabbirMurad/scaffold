use uuid::Uuid;
use chrono::Utc;
use serde::Deserialize;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Model::Project::{ ProjectComment, CommentMessage };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

const MAX_TEXT_LEN: usize = 2000;

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    x: f64,
    y: f64,
    text: String,
}

// Start a comment thread at a canvas coordinate with its first message. Any member
// with access may comment. Returns the created thread.
pub async fn task(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
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

    let comment = ProjectComment {
        uuid: Uuid::now_v7().to_string(),
        project_id,
        x: body.x,
        y: body.y,
        resolved: false,
        created_by: user.user_id.clone(),
        messages: vec![message],
        created_at: now,
        modified_at: now,
    };

    if let Err(error) = db
        .collection::<ProjectComment>("project_comment")
        .insert_one(&comment)
        .await
    {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(comment))
}
