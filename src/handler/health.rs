use std::time::Duration;
use mongodb::bson::doc;
use actix_web::HttpResponse;
use actix_web::rt::time::timeout;
use crate::BuiltIns::mongo::MongoDB;

// GET /api/v1/health — whether the service can do its job: 200 when the server
// and its database answer, 503 when the database doesn't. The desktop app calls
// this to decide whether to show its "server is down" screen, and polls it
// while that screen is up (assets/js/server-status.js).
pub async fn task() -> HttpResponse {
    let db = MongoDB.connect();
    let ping = db.run_command(doc! { "ping": 1 });
    let up = matches!(timeout(Duration::from_secs(3), ping).await, Ok(Ok(_)));
    let body = serde_json::json!({ "ok": up });
    let mut res = if up { HttpResponse::Ok() } else { HttpResponse::ServiceUnavailable() };
    res.insert_header(("Cache-Control", "no-store")).json(body)
}
