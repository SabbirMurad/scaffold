use serde_json::json;
use futures::TryStreamExt;
use mongodb::bson::doc;
use std::collections::HashMap;
use crate::Model::Account::AccountCore;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ Error, HttpResponse, HttpRequest };
use crate::Model::Project::{ ProjectCore, ProjectCollaborator };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// Pending collaboration invites addressed to the caller (by account id or by the
// email they were invited under), enriched with each project's name so the
// dashboard can show "wants Editor access to <Project>". An invitee has no
// access to the project yet, so this is the only way for them to see the invite.
pub async fn task(req: HttpRequest) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let db = MongoDB.connect();

    // The caller's email, to also match invites sent before they had an account.
    let email = match db
        .collection::<AccountCore>("account_core")
        .find_one(doc! { "uuid": &user.user_id })
        .await
    {
        Ok(account) => account.map(|a| a.email_address).unwrap_or_default(),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let invites: Vec<ProjectCollaborator> = match db
        .collection::<ProjectCollaborator>("project_collaborator")
        .find(doc! {
            "status": "Pending",
            "kind": "Invite", // exclude the user's own access requests
            "$or": [
                { "user_id": &user.user_id },
                { "email_address": &email },
            ],
        })
        .await
    {
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

    if invites.is_empty() {
        return Ok(HttpResponse::Ok().content_type("application/json").json(json!([])));
    }

    // Resolve project names in one query, dropping invites whose project is gone.
    let project_ids: Vec<String> = invites.iter().map(|i| i.project_id.clone()).collect();
    let names: HashMap<String, String> = match db
        .collection::<ProjectCore>("project_core")
        .find(doc! { "uuid": { "$in": project_ids }, "archived_at": null })
        .await
    {
        Ok(cursor) => cursor
            .try_collect::<Vec<ProjectCore>>()
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|core| (core.uuid, core.name))
            .collect(),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let payload: Vec<_> = invites
        .into_iter()
        .filter_map(|invite| {
            names.get(&invite.project_id).map(|name| {
                json!({
                    "uuid": invite.uuid,
                    "project_id": invite.project_id,
                    "project_name": name,
                    "role": invite.role.to_string(),
                    "status": invite.status.to_string(),
                    "invited_by": invite.invited_by,
                    "created_at": invite.created_at,
                })
            })
        })
        .collect();

    Ok(HttpResponse::Ok().content_type("application/json").json(payload))
}
