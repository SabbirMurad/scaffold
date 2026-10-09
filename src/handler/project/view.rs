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
    page: String,
    #[serde(rename = "panX")]
    pan_x: f64,
    #[serde(rename = "panY")]
    pan_y: f64,
    zoom: f64,
}

// Remember where the *calling* user is looking at one page of a project (pan and
// zoom), so the canvas reopens there on any computer. Personal state, stored per
// (user, project) in project_user_state like pinning — it never moves anyone
// else's view, and any member who can open the project may save theirs.
pub async fn task(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();

    // The page id becomes part of a field path (views.<page>), so only plain ids.
    let page = body.page.trim();
    if page.is_empty() || page.len() > 64 || !page.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        return Ok(Response::bad_request("Invalid page id"));
    }
    if !body.pan_x.is_finite() || !body.pan_y.is_finite() || !body.zoom.is_finite()
        || body.pan_x.abs() > 1e7 || body.pan_y.abs() > 1e7 || !(0.01..=64.0).contains(&body.zoom)
    {
        return Ok(Response::bad_request("Invalid view"));
    }

    let db = MongoDB.connect();
    if let Err(response) = super::access(&db, &project_id, &user.user_id).await {
        return Ok(response);
    }

    let now = Utc::now().timestamp_millis();
    let result = db
        .collection::<ProjectUserState>("project_user_state")
        .update_one(
            doc! { "user_id": &user.user_id, "project_id": &project_id },
            doc! {
                "$set": {
                    format!("views.{page}"): { "panX": body.pan_x, "panY": body.pan_y, "zoom": body.zoom },
                    "modified_at": now,
                },
                "$setOnInsert": {
                    "uuid": Uuid::now_v7().to_string(),
                    "user_id": &user.user_id,
                    "project_id": &project_id,
                    "pinned": false,
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
    Ok(Response::ok_message("View saved"))
}
