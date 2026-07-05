use actix_web::{Error, HttpResponse, error, web};
use tera::{Context, Tera};

pub async fn home(template: web::Data<Tera>) -> Result<HttpResponse, Error> {
    let res_data = template
        .render("home.html", &Context::new())
        .map_err(|e| error::ErrorInternalServerError(e))?;

    Ok(HttpResponse::Ok().content_type("text/html").body(res_data))
}

pub async fn auth(template: web::Data<Tera>) -> Result<HttpResponse, Error> {
    let res_data = template
        .render("auth.html", &Context::new())
        .map_err(|e| error::ErrorInternalServerError(e))?;

    Ok(HttpResponse::Ok().content_type("text/html").body(res_data))
}

pub async fn editor(template: web::Data<Tera>) -> Result<HttpResponse, Error> {
    let res_data = template
        .render("editor.html", &Context::new())
        .map_err(|e| error::ErrorInternalServerError(e))?;

    Ok(HttpResponse::Ok().content_type("text/html").body(res_data))
}

// The editor is always bound to a project (/editor/{id}). A bare /editor has no
// project to open, so send the user to their dashboard to pick or create one.
pub async fn editor_redirect() -> HttpResponse {
    HttpResponse::Found()
        .append_header(("Location", "/dashboard"))
        .finish()
}

pub async fn dashboard(template: web::Data<Tera>) -> Result<HttpResponse, Error> {
    let res_data = template
        .render("dashboard.html", &Context::new())
        .map_err(|e| error::ErrorInternalServerError(e))?;

    Ok(HttpResponse::Ok().content_type("text/html").body(res_data))
}
