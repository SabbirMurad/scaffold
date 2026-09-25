use uuid::Uuid;
use chrono::Utc;
use serde::Deserialize;
use serde_json::Value;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::{ProjectCore, ProjectDocument};
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    name: String,
    description: Option<String>,
    thumbnail_from: Option<String>,
    thumbnail_to: Option<String>,
    // Optional initial design document (the editor may create + save at once).
    content: Option<Value>,
}

pub async fn task(req: HttpRequest, body: web::Json<ReqBody>) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;

    let name = body.name.trim().to_string();
    if name.is_empty() {
        return Ok(Response::bad_request("Project name is required"));
    }
    if name.len() > 120 {
        return Ok(Response::bad_request("Project name must be within 120 characters"));
    }

    let now = Utc::now().timestamp_millis();
    let project_id = Uuid::now_v7().to_string();

    let description = body.description.clone()
        .map(|d| d.trim().to_string())
        .filter(|d| !d.is_empty());

    let core = ProjectCore {
        uuid: project_id.clone(),
        owner_id: user.user_id.clone(),
        slug: super::slugify(&name),
        name,
        description,
        thumbnail_from: body.thumbnail_from.clone().unwrap_or_else(|| "#5b8af5".to_string()),
        thumbnail_to: body.thumbnail_to.clone().unwrap_or_else(|| "#3d6de0".to_string()),
        thumbnail_image: None,
        thumbnail_sig: None,
        created_at: now,
        modified_at: now,
        archived_at: None,
        public_token: None,
    };

    let db = MongoDB.connect();

    if let Err(error) = db.collection::<ProjectCore>("project_core").insert_one(&core).await {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    let document = ProjectDocument {
        uuid: project_id.clone(),
        project_id: project_id.clone(),
        content: body.content.clone().unwrap_or_else(|| serde_json::json!({})),
        version: 1,
        modified_at: now,
        modified_by: user.user_id.clone(),
    };

    if let Err(error) = db.collection::<ProjectDocument>("project_document").insert_one(&document).await {
        log::error!("{:?}", error);
        // Roll back the orphaned core so a failed create leaves nothing behind.
        let _ = db.collection::<ProjectCore>("project_core")
            .delete_one(doc! { "uuid": &project_id }).await;
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(core))
}
