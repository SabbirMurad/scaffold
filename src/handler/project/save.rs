use chrono::Utc;
use serde::Deserialize;
use serde_json::{ json, Value };
use mongodb::bson::{ doc, Document, to_bson };
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Model::Project::{ ProjectCore, ProjectDocument, ProjectRole };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    content: Value,
    // The version the client last loaded; if it no longer matches, the save is
    // rejected so a stale editor can't clobber a newer save (optimistic locking).
    version: Option<i64>,
}

// Persist the design document. Requires editor access or higher.
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
        return Ok(Response::forbidden("You need edit access to save this project"));
    }

    let now = Utc::now().timestamp_millis();
    let document_collection = db.collection::<ProjectDocument>("project_document");

    // Optimistic concurrency: bail if the client's base version is stale.
    if let Some(expected) = body.version {
        let current = match document_collection
            .find_one(doc! { "project_id": &project_id })
            .await
        {
            Ok(document) => document,
            Err(error) => {
                log::error!("{:?}", error);
                return Ok(Response::internal_server_error(&error.to_string()));
            }
        };

        if let Some(current) = current {
            if current.version != expected {
                return Ok(Response::conflict(
                    "This project was updated elsewhere. Reload before saving.",
                ));
            }
        }
    }

    // The client sends a partial document: only the top-level slices it changed
    // (nodes, colors, models, …). Merge each one into `content.<slice>` rather than
    // replacing the whole `content`, so an untouched tab isn't rewritten. A full
    // save is just the case where every slice is present.
    let content_obj = match body.content.as_object() {
        Some(map) => map,
        None => return Ok(Response::bad_request("content must be an object")),
    };

    let mut set = Document::new();
    for (slice, value) in content_obj {
        // Convert to native BSON so it stores structured (not stringified).
        let value_bson = match to_bson(value) {
            Ok(bson) => bson,
            Err(error) => {
                log::error!("{:?}", error);
                return Ok(Response::internal_server_error(&error.to_string()));
            }
        };
        set.insert(format!("content.{slice}"), value_bson);
    }
    set.insert("modified_at", now);
    set.insert("modified_by", &user.user_id);

    let result = document_collection
        .update_one(
            doc! { "project_id": &project_id },
            doc! { "$set": set, "$inc": { "version": 1 } },
        )
        .await;

    let update = match result {
        Ok(update) => update,
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    if update.matched_count == 0 {
        return Ok(Response::not_found("Project document not found"));
    }

    // Keep the project's modified_at in step so the dashboard sorts correctly.
    let _ = db
        .collection::<ProjectCore>("project_core")
        .update_one(
            doc! { "uuid": &project_id },
            doc! { "$set": { "modified_at": now } },
        )
        .await;

    let new_version = document_collection
        .find_one(doc! { "project_id": &project_id })
        .await
        .ok()
        .flatten()
        .map(|document| document.version)
        .unwrap_or(0);

    Ok(HttpResponse::Ok().content_type("application/json").json(json!({
        "version": new_version,
        "modified_at": now,
    })))
}
