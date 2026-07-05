use mongodb::bson::doc;
use crate::{builtins::mongo::MongoDB, model, utils::response::Response};
use actix_web::{web, Error, HttpResponse};

pub async fn task(email_or_username: web::Path<String>,) -> Result<HttpResponse, Error> {
    let email_or_username = email_or_username.trim().to_string().to_lowercase();

    if email_or_username.len() == 0 {
        return Ok(Response::bad_request("Email is required"));
    }

    let db = MongoDB.connect();
    let collection = db.collection::<model::Account::AccountCore>("account_core");

    let result = collection.find_one(
        doc!{"$and":[
            {"email_address": &email_or_username},
            {"email_verified": true}
        ]}
    ).await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    let option = result.unwrap();
    if let None = option {
        return Ok(Response::not_found(
            "No user found with this email or username"
        ));
    }

    let account_core = option.unwrap();
    let user_id = account_core.uuid.clone();

    let collection = db.collection::<model::Account::AccountProfile>("account_profile");

    let result = collection.find_one(
        doc!{"uuid": &user_id}
    ).await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    let option = result.unwrap();
    if let None = option {
        return Ok(Response::not_found(
            "No user found with this email or username"
        ));
    }

    let account_profile = option.unwrap();

    let data = serde_json::json!({
        "user_id": user_id,
        "full_name": account_profile.full_name,
        "profile_picture": account_profile.profile_picture,
    });

    Ok(HttpResponse::Ok().content_type("application/json").json(data))
}