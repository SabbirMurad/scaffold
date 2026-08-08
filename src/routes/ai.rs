use actix_web::web;
use crate::Handler;

// AI endpoints (Claude-backed). Text-to-design generation.
pub fn router(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1/ai")
            .route("/generate", web::post().to(Handler::Ai::Generate::task)),
    );
}
