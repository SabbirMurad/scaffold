use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Account::{ AccountCore, AccountProfile };
use actix_web::{ Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// The signed-in user's profile, resolved from the access token (not a public
// email lookup). Powers the name/email/avatar shown in the dashboard + editor.
pub async fn task(req: HttpRequest) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let db = MongoDB.connect();

    let core = match db
        .collection::<AccountCore>("account_core")
        .find_one(doc! { "uuid": &user.user_id })
        .await
    {
        Ok(Some(core)) => core,
        Ok(None) => return Ok(Response::not_found("Account not found")),
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let profile = match db
        .collection::<AccountProfile>("account_profile")
        .find_one(doc! { "uuid": &user.user_id })
        .await
    {
        Ok(profile) => profile,
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    let data = serde_json::json!({
        "user_id": user.user_id,
        "email_address": core.email_address,
        "full_name": profile.as_ref().map(|p| p.full_name.clone()).unwrap_or_default(),
        "profile_picture": profile.and_then(|p| p.profile_picture),
    });
    Ok(HttpResponse::Ok().content_type("application/json").json(data))
}
