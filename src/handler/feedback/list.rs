use serde::Serialize;
use futures::TryStreamExt;
use mongodb::bson::doc;
use crate::Model::Feedback::Feedback;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use actix_web::{ Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// The caller's recent feedback plus the cap state the dashboard needs to render
// "N of M left today" and enable/disable the form.
#[derive(Serialize)]
struct FeedbackList {
    max_per_day: i64,
    used_today: i64,
    items: Vec<Feedback>,
}

// How many recent items to return for the history list (the UI shows ~8).
const HISTORY_LIMIT: i64 = 20;

pub async fn task(req: HttpRequest) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let db = MongoDB.connect();
    let collection = db.collection::<Feedback>("feedback");

    // Today's usage, straight from the source of truth (not derived on the client).
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

    // Recent history, newest first.
    let items: Vec<Feedback> = match collection
        .find(doc! { "user_id": &user.user_id })
        .sort(doc! { "created_at": -1 })
        .limit(HISTORY_LIMIT)
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

    let payload = FeedbackList { max_per_day: super::MAX_PER_DAY, used_today, items };
    Ok(HttpResponse::Ok().content_type("application/json").json(payload))
}
