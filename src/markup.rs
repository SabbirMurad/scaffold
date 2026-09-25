use actix_web::{Error, HttpResponse, error, web};
use tera::{Context, Tera};

pub async fn home(template: web::Data<Tera>) -> Result<HttpResponse, Error> {
    let res_data = template
        .render("home.html", &Context::new())
        .map_err(|e| error::ErrorInternalServerError(e))?;

    Ok(HttpResponse::Ok().content_type("text/html").body(res_data))
}

// Sign in, the dashboard and the editor live in the desktop app now. Old links
// to those pages land on the landing page's download section instead.
pub async fn desktop_only() -> HttpResponse {
    HttpResponse::Found()
        .append_header(("Location", "/#download"))
        .finish()
}
