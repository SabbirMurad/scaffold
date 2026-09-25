// Public view links: read-only access to one project's design for anyone holding
// its token (see project/public_link.rs). No account needed. Serves the design,
// its comment threads and its images — nothing that edits, and nothing about the
// project's members beyond comment authors' names.

use futures::TryStreamExt;
use mongodb::{ Database, bson::doc };
use serde_json::json;
use actix_web::{ web, Error, HttpResponse };
use crate::BuiltIns::image;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::{ ProjectCore, ProjectDocument, ProjectComment };

// Tokens are 32 hex characters; anything else is rejected before touching the DB.
pub fn valid_token(token: &str) -> bool {
    token.len() == 32 && token.chars().all(|c| c.is_ascii_hexdigit())
}

// The active project a token opens, or a 404 (the link was never valid, was
// turned off, or the project was deleted — all look the same from outside).
pub async fn project_by_token(db: &Database, token: &str) -> Result<ProjectCore, HttpResponse> {
    let not_found = || Response::not_found("This link isn't active");
    if !valid_token(token) {
        return Err(not_found());
    }
    match db
        .collection::<ProjectCore>("project_core")
        .find_one(doc! { "public_token": token, "archived_at": null })
        .await
    {
        Ok(Some(core)) => Ok(core),
        Ok(None) => Err(not_found()),
        Err(error) => {
            log::error!("{:?}", error);
            Err(Response::internal_server_error(&error.to_string()))
        }
    }
}

// The project's name and design document.
pub async fn project(path: web::Path<String>) -> Result<HttpResponse, Error> {
    let db = MongoDB.connect();
    let core = match project_by_token(&db, &path.into_inner()).await {
        Ok(core) => core,
        Err(response) => return Ok(response),
    };
    let document = match db
        .collection::<ProjectDocument>("project_document")
        .find_one(doc! { "project_id": &core.uuid })
        .await
    {
        Ok(document) => document,
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };
    Ok(HttpResponse::Ok().content_type("application/json").json(json!({
        "project": { "name": core.name },
        "document": document.map(|d| json!({ "content": d.content, "version": d.version })),
    })))
}

// Comment threads, oldest first — positions, state and messages (author names,
// not account ids).
pub async fn comments(path: web::Path<String>) -> Result<HttpResponse, Error> {
    let db = MongoDB.connect();
    let core = match project_by_token(&db, &path.into_inner()).await {
        Ok(core) => core,
        Err(response) => return Ok(response),
    };
    let threads = match db
        .collection::<ProjectComment>("project_comment")
        .find(doc! { "project_id": &core.uuid })
        .sort(doc! { "created_at": 1 })
        .await
    {
        Ok(cursor) => cursor.try_collect::<Vec<ProjectComment>>().await.unwrap_or_default(),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };
    let threads: Vec<_> = threads
        .into_iter()
        .map(|t| json!({
            "uuid": t.uuid, "x": t.x, "y": t.y, "resolved": t.resolved,
            "messages": t.messages.into_iter().map(|m| json!({
                "author_name": m.author_name, "text": m.text, "created_at": m.created_at,
            })).collect::<Vec<_>>(),
        }))
        .collect();
    Ok(HttpResponse::Ok().content_type("application/json").json(threads))
}

// A design image's bytes, if it belongs to the linked project.
pub async fn image(path: web::Path<(String, String)>) -> Result<HttpResponse, Error> {
    let (token, image_id) = path.into_inner();
    let db = MongoDB.connect();
    let core = match project_by_token(&db, &token).await {
        Ok(core) => core,
        Err(response) => return Ok(response),
    };
    let stored = match image::get(&image_id).await {
        Ok(Some(image)) if image.project_id == core.uuid => image,
        Ok(_) => return Ok(Response::not_found("Image not found")),
        Err(msg) => return Ok(Response::internal_server_error(&msg)),
    };
    Ok(HttpResponse::Ok()
        .content_type(stored.mime.as_str())
        // Only readable while the link is on, so keep caching short and private.
        .append_header(("Cache-Control", "private, max-age=3600"))
        .body(stored.bytes))
}
