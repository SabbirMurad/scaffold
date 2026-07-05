use uuid::Uuid;
use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::doc;
use crate::Model::Account::AccountCore;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::utils::validation::validate_email;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };
use crate::Model::Project::{ ProjectCollaborator, ProjectRole, ShareStatus, CollaboratorKind };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    email_address: String,
    role: Option<String>, // "Viewer" | "Editor" (defaults to Editor)
}

// Invite someone to collaborate on a project by email. Owner only.
pub async fn task(
    req: HttpRequest,
    path: web::Path<String>,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
    let db = MongoDB.connect();

    let (core, role) = match super::access(&db, &project_id, &user.user_id).await {
        Ok(result) => result,
        Err(response) => return Ok(response),
    };

    if role != ProjectRole::Owner {
        return Ok(Response::forbidden("Only the owner can invite collaborators"));
    }

    let email = body.email_address.trim().to_lowercase();
    if email.is_empty() {
        return Ok(Response::bad_request("Email is required"));
    }
    if let Err(error) = validate_email(&email) {
        return Ok(Response::bad_request(&error));
    }

    // Invites can grant view or edit access; ownership can't be handed out here.
    let invite_role = match body.role.as_deref().map(|r| r.trim().to_lowercase()) {
        Some(ref r) if r == "viewer" => ProjectRole::Viewer,
        None => ProjectRole::Editor,
        Some(ref r) if r == "editor" => ProjectRole::Editor,
        Some(ref r) if r == "owner" => {
            return Ok(Response::bad_request("Collaborators can't be invited as owner"));
        }
        Some(_) => return Ok(Response::bad_request("Invalid role")),
    };

    // Resolve the invitee's account if they already have one.
    let invitee_id = match db
        .collection::<AccountCore>("account_core")
        .find_one(doc! { "email_address": &email })
        .await
    {
        Ok(account) => account.map(|a| a.uuid),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    if invitee_id.as_deref() == Some(core.owner_id.as_str()) {
        return Ok(Response::bad_request("This person already owns the project"));
    }

    let collaborator_collection = db.collection::<ProjectCollaborator>("project_collaborator");

    // Don't stack duplicate outstanding/active invites for the same email.
    let existing = collaborator_collection
        .find_one(doc! {
            "project_id": &project_id,
            "email_address": &email,
            "status": { "$ne": "Declined" },
        })
        .await;

    match existing {
        Ok(Some(_)) => return Ok(Response::conflict("This person has already been invited")),
        Ok(None) => {}
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    }

    let now = Utc::now().timestamp_millis();
    let collaborator = ProjectCollaborator {
        uuid: Uuid::now_v7().to_string(),
        project_id: project_id.clone(),
        user_id: invitee_id,
        email_address: email,
        role: invite_role,
        status: ShareStatus::Pending,
        kind: CollaboratorKind::Invite,
        invited_by: user.user_id.clone(),
        created_at: now,
        responded_at: None,
    };

    if let Err(error) = collaborator_collection.insert_one(&collaborator).await {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(collaborator))
}
