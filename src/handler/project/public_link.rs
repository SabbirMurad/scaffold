use rand::Rng;
use serde::Deserialize;
use serde_json::json;
use mongodb::bson::{ doc, Bson };
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::{ ProjectCore, ProjectRole };
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    enabled: bool,
}

// Turn the project's public view link on or off (owner only, like inviting).
// On: reuse the current token, or mint one. Off: clear it, so the old link stops
// working — turning it back on gives a new link.
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
        return Ok(Response::forbidden("Only the owner can change the public link"));
    }

    let token = if body.enabled {
        Some(core.public_token.unwrap_or_else(new_token))
    } else {
        None
    };

    let result = db
        .collection::<ProjectCore>("project_core")
        .update_one(
            doc! { "uuid": &project_id },
            doc! { "$set": { "public_token": token.clone().map(Bson::String).unwrap_or(Bson::Null) } },
        )
        .await;
    if let Err(error) = result {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(json!({ "public_token": token })))
}

// 128 random bits as hex: unguessable, URL-safe.
fn new_token() -> String {
    format!("{:032x}", rand::rng().random::<u128>())
}
