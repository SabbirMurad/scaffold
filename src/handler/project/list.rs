use serde::Serialize;
use futures::TryStreamExt;
use std::collections::HashSet;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ Error, HttpResponse, HttpRequest };
use crate::Model::Project::{ ProjectCore, ProjectCollaborator, ProjectUserState };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// A project as it appears on the caller's dashboard: the shared metadata plus
// this caller's personal `pinned` flag (pinning is per-user, so it can differ
// between members of the same project).
#[derive(Serialize)]
struct ProjectListItem {
    #[serde(flatten)]
    core: ProjectCore,
    pinned: bool,
}

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

    // The caller's personal pinned set across those projects. Best-effort: if the
    // lookup fails, everything simply renders unpinned rather than failing the list.
    let project_ids: Vec<&String> = projects.iter().map(|p| &p.uuid).collect();
    let pinned_ids: HashSet<String> = if project_ids.is_empty() {
        HashSet::new()
    } else {
        match db
            .collection::<ProjectUserState>("project_user_state")
            .find(doc! {
                "user_id": &user.user_id,
                "project_id": { "$in": &project_ids },
                "pinned": true,
            })
            .await
        {
            Ok(cursor) => cursor
                .try_collect::<Vec<ProjectUserState>>()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|s| s.project_id)
                .collect(),
            Err(error) => {
                log::error!("{:?}", error);
                HashSet::new()
            }
        }
    };

    let items: Vec<ProjectListItem> = projects
        .into_iter()
        .map(|mut core| {
            // The public link is the owner's to hand out.
            if core.owner_id != user.user_id {
                core.public_token = None;
            }
            ProjectListItem { pinned: pinned_ids.contains(&core.uuid), core }
        })
        .collect();

    Ok(HttpResponse::Ok().content_type("application/json").json(items))
}
