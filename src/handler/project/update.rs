use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::{ doc, Document };
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::{ ProjectCore, ProjectRole };
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    name: Option<String>,
    description: Option<String>,
    thumbnail_from: Option<String>,
    thumbnail_to: Option<String>,
    pinned: Option<bool>,
}

// Update a project's metadata (name, description, thumbnail, pin). Requires
// editor access or higher.
pub async fn task(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
    let db = MongoDB.connect();

    let (_core, role) = match super::access(&db, &project_id, &user.user_id).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    if super::role_rank(&role) < super::role_rank(&ProjectRole::Editor) {
        return Ok(Response::forbidden("You need edit access to change this project"));
    }

    let mut set = Document::new();

    if let Some(name) = &body.name {
        let name = name.trim();
        if name.is_empty() {
            return Ok(Response::bad_request("Project name cannot be empty"));
        }
        if name.len() > 120 {
            return Ok(Response::bad_request("Project name must be within 120 characters"));
        }
        set.insert("name", name);
        set.insert("slug", super::slugify(name));
    }
    if let Some(description) = &body.description {
        set.insert("description", description.trim());
    }
    if let Some(from) = &body.thumbnail_from {
        set.insert("thumbnail_from", from.trim());
    }
    if let Some(to) = &body.thumbnail_to {
        set.insert("thumbnail_to", to.trim());
    }
    if let Some(pinned) = body.pinned {
        set.insert("pinned", pinned);
    }

    if set.is_empty() {
        return Ok(Response::bad_request("No fields to update"));
    }

    let now = Utc::now().timestamp_millis();
    set.insert("modified_at", now);

    let result = db
        .collection::<ProjectCore>("project_core")
        .update_one(doc! { "uuid": &project_id }, doc! { "$set": set })
        .await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(Response::ok_message("Project updated"))
}
