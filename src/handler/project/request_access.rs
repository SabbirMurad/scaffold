use uuid::Uuid;
use chrono::Utc;
use mongodb::bson::doc;
use crate::Model::Account::AccountCore;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };
use crate::Model::Project::{ ProjectCore, ProjectCollaborator, ProjectRole, ShareStatus, CollaboratorKind };

// Ask for access to a project the caller can't currently open. Creates a pending
// Request collaborator record that surfaces in the owner's share modal, where
// they can grant or decline it. The caller is deliberately *not* a member yet,
// so this loads the project directly rather than through the access() gate.
pub async fn task(req: HttpRequest, path: web::Path<String>) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
    let db = MongoDB.connect();

    // The project must exist and be active.
    let core = match db
        .collection::<ProjectCore>("project_core")
        .find_one(doc! { "uuid": &project_id, "archived_at": null })
        .await
    {
        Ok(Some(core)) => core,
        Ok(None) => return Ok(Response::not_found("Project not found")),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    if core.owner_id == user.user_id {
        return Ok(Response::bad_request("You already own this project"));
    }

    let collaborator_collection = db.collection::<ProjectCollaborator>("project_collaborator");

    // If there's already a live record for this user (invited, requested, or a
    // member), don't stack another. A previously declined one can be re-requested.
    let existing = collaborator_collection
        .find_one(doc! {
            "project_id": &project_id,
            "user_id": &user.user_id,
            "status": { "$ne": "Declined" },
        })
        .await;

    match existing {
        Ok(Some(record)) => {
            let message = match record.status {
                ShareStatus::Accepted => "You already have access to this project",
                _ if record.kind == CollaboratorKind::Invite => "You already have a pending invite to this project",
                _ => "You've already requested access to this project",
            };
            return Ok(Response::conflict(message));
        }
        Ok(None) => {}
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    }

    // Record the caller's email so the owner sees who is asking.
    let email = match db
        .collection::<AccountCore>("account_core")
        .find_one(doc! { "uuid": &user.user_id })
        .await
    {
        Ok(Some(account)) => account.email_address,
        Ok(None) => return Ok(Response::not_found("Account not found")),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let now = Utc::now().timestamp_millis();
    let request = ProjectCollaborator {
        uuid: Uuid::now_v7().to_string(),
        project_id: project_id.clone(),
        user_id: Some(user.user_id.clone()),
        email_address: email,
        role: ProjectRole::Editor, // requested default; the owner can change it on grant
        status: ShareStatus::Pending,
        kind: CollaboratorKind::Request,
        invited_by: user.user_id.clone(), // self-initiated
        created_at: now,
        responded_at: None,
    };

    if let Err(error) = collaborator_collection.insert_one(&request).await {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(Response::ok_message("Access request sent"))
}
