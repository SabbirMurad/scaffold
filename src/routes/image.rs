use actix_web::web;
use crate::Handler;

pub fn router(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1/image")
        .route(
            "/{id}",
            web::get().to(Handler::Image::Get::task)   // serve image bytes (project-gated)
        )
    );
}
