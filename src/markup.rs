use actix_web::{Error, HttpResponse, error, web};
use tera::{Context, Tera};

pub async fn home(template: web::Data<Tera>) -> Result<HttpResponse, Error> {
    let res_data = template
        .render("home.html", &Context::new())
        .map_err(|e| error::ErrorInternalServerError(e))?;

    Ok(HttpResponse::Ok().content_type("text/html").body(res_data))
}

// A public view link: the desktop app's editor page, opened in the browser in
// public view mode (read-only, the Design tab only — see bootPublic in app.js).
// The page is the desktop app's own editor.html, so there is one editor to keep
// up to date; the desktop's app-config script is swapped for the link's token.
pub async fn public_view(path: web::Path<String>) -> HttpResponse {
    let token = path.into_inner();
    if !crate::Handler::Public::valid_token(&token) {
        return HttpResponse::Found().append_header(("Location", "/")).finish();
    }
    match std::fs::read_to_string("desktop/src/editor.html") {
        Ok(html) => {
            let html = html.replace(
                r#"<script src="/app-config.js"></script>"#,
                &format!(r#"<script>window.SCAFFOLD_PUBLIC = "{token}";</script>"#),
            );
            HttpResponse::Ok()
                .content_type("text/html")
                .append_header(("Cache-Control", "no-store"))
                .body(html)
        }
        Err(error) => {
            log::error!("public view page: {:?}", error);
            HttpResponse::InternalServerError().finish()
        }
    }
}

// Sign in, the dashboard and the editor live in the desktop app now. Old links
// to those pages land on the landing page's download section instead.
pub async fn desktop_only() -> HttpResponse {
    HttpResponse::Found()
        .append_header(("Location", "/#download"))
        .finish()
}
