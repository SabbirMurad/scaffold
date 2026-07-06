use uuid::Uuid;
use chrono::Utc;
use serde::Deserialize;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Feedback::{ Feedback, FeedbackKind };
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

#[derive(Debug, Deserialize)]
pub struct ReqBody {
    // "Bug" | "Idea" | "Question" | "Other" — anything else falls back to Other.
    r#type: Option<String>,
    message: String,
}

// Submit a piece of feedback. Enforces the per-user, per-calendar-day cap
// server-side (the client also disables the form, but that isn't trustworthy).
pub async fn task(req: HttpRequest, body: web::Json<ReqBody>) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;

    let message = body.message.trim().to_string();
    if message.is_empty() {
        return Ok(Response::bad_request("Feedback message cannot be empty"));
    }
    if message.chars().count() > super::MAX_MESSAGE_LEN {
        return Ok(Response::bad_request(&format!(
            "Feedback must be within {} characters",
            super::MAX_MESSAGE_LEN
        )));
    }

    let kind = body.r#type.as_deref().map(FeedbackKind::parse).unwrap_or_default();

    let db = MongoDB.connect();
    let collection = db.collection::<Feedback>("feedback");

    // Enforce the daily cap: count today's submissions before inserting.
    let used_today = match collection
        .count_documents(doc! {
            "user_id": &user.user_id,
            "created_at": { "$gte": super::start_of_utc_day_ms() },
        })
        .await
    {
        Ok(count) => count as i64,
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    if used_today >= super::MAX_PER_DAY {
        return Ok(Response::too_many_requests(&format!(
            "You can only send {} feedbacks a day — try again tomorrow",
            super::MAX_PER_DAY
        )));
    }

    let feedback = Feedback {
        uuid: Uuid::now_v7().to_string(),
        user_id: user.user_id.clone(),
        kind,
        message,
        created_at: Utc::now().timestamp_millis(),
    };

    if let Err(error) = collection.insert_one(&feedback).await {
        log::error!("{:?}", error);
        return Ok(Response::internal_server_error(&error.to_string()));
    }

    Ok(HttpResponse::Ok().content_type("application/json").json(feedback))
}
