use actix_web::web;
use crate::Markup;
use crate::handler::seo::{ sitemap, robots };

pub fn router(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("")
        .route(
            "/",
            web::get().to(Markup::home)
        )
        .route(
            "/dashboard",
            web::get().to(Markup::desktop_only)
        )
        .route(
            "/editor",
            web::get().to(Markup::desktop_only)
        )
        .route(
            "/editor/{id}",
            web::get().to(Markup::desktop_only)
        )
        .route(
            "/authentication",
            web::get().to(Markup::desktop_only)
        )
        .route(
            "/auth/social",
            web::get().to(Markup::social_auth)   // Google / GitHub sign-in for the desktop app
        )
        .route(
            "/view/{token}",
            web::get().to(Markup::public_view)
        )
        .route(
            "/sitemap.xml",
            web::get().to(sitemap::handler)
        )
        .route(
            "/robots.txt",
            web::get().to(robots::handler)
        )
    );
}
