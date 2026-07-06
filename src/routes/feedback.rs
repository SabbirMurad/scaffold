use actix_web::web;
use crate::Handler;

pub fn router(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1/feedback")
        .route(
            "",
            web::post().to(Handler::Feedback::Create::task)   // submit feedback
        )
        .route(
            "",
            web::get().to(Handler::Feedback::List::task)      // my recent + cap state
        )
    );
}
