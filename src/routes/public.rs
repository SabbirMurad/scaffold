use actix_web::web;
use crate::Handler;

// Read-only access through a public view link (no account needed).
pub fn router(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1/public")
        .route("/{token}", web::get().to(Handler::Public::project))
        .route("/{token}/comments", web::get().to(Handler::Public::comments))
        .route("/{token}/image/{image_id}", web::get().to(Handler::Public::image))
    );
}
