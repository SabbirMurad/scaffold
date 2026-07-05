use futures::TryStreamExt;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ Error, HttpResponse, HttpRequest };
use crate::Model::Project::{ ProjectCore, ProjectCollaborator };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// Every active project the caller can open: the ones they own, plus the ones
// shared with them and accepted.
pub async fn task(req: HttpRequest) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let db = MongoDB.connect();
    let core_collection = db.collection::<ProjectCore>("project_core");

    // Owned projects.
    let owned = core_collection
        .find(doc! { "owner_id": &user.user_id, "archived_at": null })
        .await;

    let mut projects: Vec<ProjectCore> = match owned {
        Ok(cursor) => match cursor.try_collect().await {
            Ok(list) => list,
            Err(error) => {
                log::error!("{:?}", error);
                return Ok(Response::internal_server_error(&error.to_string()));
            }
        },
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    // Projects shared with (and accepted by) the caller.
    let shared_ids: Vec<String> = match db
        .collection::<ProjectCollaborator>("project_collaborator")
        .find(doc! { "user_id": &user.user_id, "status": "Accepted" })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<ProjectCollaborator>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|c| c.project_id)
            .collect(),
        Err(error) => {
            log::error!("{:?}", error);
            Vec::new()
        }
    };

    if !shared_ids.is_empty() {
        if let Ok(cursor) = core_collection
            .find(doc! { "uuid": { "$in": shared_ids }, "archived_at": null })
            .await
        {
            if let Ok(mut shared) = cursor.try_collect::<Vec<ProjectCore>>().await {
                projects.append(&mut shared);
            }
        }
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(projects))
}
