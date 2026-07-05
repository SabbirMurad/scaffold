use mongodb::{Database, bson::doc};
use actix_web::HttpResponse;
use crate::utils::response::Response;
use crate::Model::Project::{ProjectCore, ProjectRole, ProjectCollaborator};

pub mod create;
pub use create as Create;

pub mod list;
pub use list as List;

pub mod get;
pub use get as Get;

pub mod save;
pub use save as Save;

pub mod update;
pub use update as Update;

pub mod delete;
pub use delete as Delete;

pub mod invite;
pub use invite as Invite;

pub mod collaborators;
pub use collaborators as Collaborators;

pub mod respond;
pub use respond as Respond;

pub mod request_access;
pub use request_access as RequestAccess;

pub mod set_role;
pub use set_role as SetRole;

pub mod remove_collaborator;
pub use remove_collaborator as RemoveCollaborator;

pub mod my_invites;
pub use my_invites as MyInvites;

// Privilege ordering for role checks (Viewer < Editor < Owner).
pub fn role_rank(role: &ProjectRole) -> u8 {
    match role {
        ProjectRole::Viewer => 1,
        ProjectRole::Editor => 2,
        ProjectRole::Owner => 3,
    }
}

// snake_case identity from a project name, used as the generated package/route
// base (e.g. "Mobile Banking App" → "mobile_banking_app").
pub fn slugify(name: &str) -> String {
    let mut out = String::new();
    let mut prev_underscore = false;
    for c in name.trim().to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c);
            prev_underscore = false;
        } else if !prev_underscore {
            out.push('_');
            prev_underscore = true;
        }
    }
    let s = out.trim_matches('_').to_string();
    if s.is_empty() { "project".to_string() } else { s }
}

// Load an active project plus the caller's effective role on it. Returns the
// owner role when the caller owns it, the accepted-collaborator role otherwise,
// and an error response (404 / 403 / 500) when it can't be accessed.
pub async fn access(
    db: &Database,
    project_id: &str,
    user_id: &str,
) -> Result<(ProjectCore, ProjectRole), HttpResponse> {
    let core = db
        .collection::<ProjectCore>("project_core")
        .find_one(doc! { "uuid": project_id, "archived_at": null })
        .await
        .map_err(|error| {
            log::error!("{:?}", error);
            Response::internal_server_error(&error.to_string())
        })?;

    let core = match core {
        Some(core) => core,
        None => return Err(Response::not_found("Project not found")),
    };

    if core.owner_id == user_id {
        return Ok((core, ProjectRole::Owner));
    }

    let collaborator = db
        .collection::<ProjectCollaborator>("project_collaborator")
        .find_one(doc! {
            "project_id": project_id,
            "user_id": user_id,
            "status": "Accepted",
        })
        .await
        .map_err(|error| {
            log::error!("{:?}", error);
            Response::internal_server_error(&error.to_string())
        })?;

    match collaborator {
        Some(collaborator) => Ok((core, collaborator.role)),
        None => Err(Response::forbidden("You don't have access to this project")),
    }
}
