use uuid::Uuid;
use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::ProjectUserState;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    pinned: bool,
}

// Pin or unpin a project for the *calling* user. This is personal dashboard
// state stored per (user, project) in project_user_state, so it never affects
// how the project appears to other members. Any member who can open the project
// (Viewer or higher) may pin it — unlike shared metadata, pinning is not an edit.
pub async fn task(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
    let db = MongoDB.connect();

    // Confirm the caller can actually see this project (404/403 otherwise).
    if let Err(response) = super::access(&db, &project_id, &user.user_id).await {
        return Ok(response);
    }

    let now = Utc::now().timestamp_millis();

    // Upsert the caller's personal state row: flip `pinned`, seed the immutable
    // fields only when the row is first created.
    let result = db
        .collection::<ProjectUserState>("project_user_state")
        .update_one(
            doc! { "user_id": &user.user_id, "project_id": &project_id },
            doc! {
                "$set": { "pinned": body.pinned, "modified_at": now },
                "$setOnInsert": {
                    "uuid": Uuid::now_v7().to_string(),
                    "user_id": &user.user_id,
                    "project_id": &project_id,
                    "last_opened_at": null,
                    "created_at": now,
                },
            },
        )
        .upsert(true)
        .await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(Response::ok_message(if body.pinned { "Project pinned" } else { "Project unpinned" }))
}
