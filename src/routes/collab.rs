use actix_web::web;
use crate::Handler;

// Live collaboration WebSocket. One room per project; the token rides as a query
// parameter (the browser can't set headers on a WS handshake).
pub fn router(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1/ws")
            .route("/project/{id}", web::get().to(Handler::Collab::Connect::task)),
    );
}
