use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::{ doc, Bson };
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Account::AccountProfile;
use crate::utils::validation::validate_full_name;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

pub const MAX_BIOGRAPHY: usize = 500;

// Every field is optional: only the ones sent are changed.
#[derive(Debug, Deserialize)]
pub struct ReqBody {
    full_name: Option<String>,
    biography: Option<String>,
}

// Update the signed-in user's own profile (name, bio). The picture has its own
// endpoint (see avatar.rs) since it's raw image bytes, not JSON.
pub async fn task(
    req: HttpRequest,
    body: web::Json<ReqBody>,
) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let mut set = doc! { "modified_at": Utc::now().timestamp_millis() };

    if let Some(full_name) = &body.full_name {
        let full_name = full_name.trim();
        if let Err(error) = validate_full_name(full_name) {
            return Ok(Response::bad_request(&error));
        }
        set.insert("full_name", full_name);
    }

    if let Some(biography) = &body.biography {
        let biography = biography.trim();
        if biography.chars().count() > MAX_BIOGRAPHY {
            return Ok(Response::bad_request(
                &format!("Bio must be within {} characters", MAX_BIOGRAPHY)
            ));
        }
        // An empty bio clears it.
        if biography.is_empty() { set.insert("biography", Bson::Null); }
        else { set.insert("biography", biography); }
    }

    let result = MongoDB.connect()
        .collection::<AccountProfile>("account_profile")
        .update_one(doc! { "uuid": &user.user_id }, doc! { "$set": set })
        .await;

    match result {
        Ok(result) if result.matched_count == 0 => Ok(Response::not_found("Profile not found")),
        Ok(_) => Ok(Response::ok_message("Profile updated")),
        Err(error) => {
            log::error!("{:?}", error);
            Ok(Response::internal_server_error(&error.to_string()))
        }
    }
}
