use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::{ doc, Document };
use crate::Model::Account::AccountCore;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };
use crate::Model::Project::{ ProjectCollaborator, ProjectCore, ShareStatus, CollaboratorKind };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    status: String, // "Accepted" | "Declined"
}

// Resolve a pending collaborator record. Who may answer depends on its kind:
//   • Invite  — the owner invited someone, so the invitee accepts/declines.
//   • Request — an outsider asked for access, so the owner accepts/declines.
pub async fn task(
    req: HttpRequest,
    path: web::Path<(String, String)>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let (project_id, invite_id) = path.into_inner();

    let new_status = match body.status.trim().to_lowercase().as_str() {
        "accepted" => ShareStatus::Accepted,
        "declined" => ShareStatus::Declined,
        _ => return Ok(Response::bad_request("Status must be Accepted or Declined")),
    };

    let db = MongoDB.connect();
    let collaborator_collection = db.collection::<ProjectCollaborator>("project_collaborator");

    let record = match collaborator_collection
        .find_one(doc! { "uuid": &invite_id, "project_id": &project_id })
        .await
    {
        Ok(Some(record)) => record,
        Ok(None) => return Ok(Response::not_found("Collaboration record not found")),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    if record.status != ShareStatus::Pending {
        return Ok(Response::bad_request("This has already been answered"));
    }

    let is_request = record.kind == CollaboratorKind::Request;

    if is_request {
        // Access request → only the project owner may approve or decline it.
        let owner_id = match db
            .collection::<ProjectCore>("project_core")
            .find_one(doc! { "uuid": &project_id })
            .await
        {
            Ok(Some(core)) => core.owner_id,
            Ok(None) => return Ok(Response::not_found("Project not found")),
            Err(error) => {
                log::error!("{:?}", error);
                return Ok(Response::internal_server_error(&error.to_string()));
            }
        };
        if owner_id != user.user_id {
            return Ok(Response::forbidden("Only the owner can answer access requests"));
        }
    } else {
        // Invite → only the invitee may respond (matched by account or email).
        let my_email = match db
            .collection::<AccountCore>("account_core")
            .find_one(doc! { "uuid": &user.user_id })
            .await
        {
            Ok(account) => account.map(|a| a.email_address),
            Err(error) => {
                log::error!("{:?}", error);
                return Ok(Response::internal_server_error(&error.to_string()));
            }
        };
        let is_mine = record.user_id.as_deref() == Some(user.user_id.as_str())
            || my_email.as_deref() == Some(record.email_address.as_str());
        if !is_mine {
            return Ok(Response::forbidden("This invite isn't for you"));
        }
    }

    let now = Utc::now().timestamp_millis();
    let mut set = Document::new();
    set.insert("status", new_status.to_string());
    set.insert("responded_at", now);
    // Bind the invitee's account when they accept their own invite. (For a
    // request the record already carries the requester's user_id.)
    if !is_request {
        set.insert("user_id", &user.user_id);
    }

    let result = collaborator_collection
        .update_one(doc! { "uuid": &invite_id }, doc! { "$set": set })
        .await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    let message = match (is_request, &new_status) {
        (true, ShareStatus::Accepted) => "Access granted",
        (true, _) => "Access request declined",
        (false, ShareStatus::Accepted) => "Invite accepted",
        (false, _) => "Invite declined",
    };
    Ok(Response::ok_message(message))
}
