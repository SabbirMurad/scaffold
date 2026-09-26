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

#[derive(serde::Deserialize)]
pub struct SocialAuthQuery {
    provider: String,
    port: u16,
    state: String,
}

// Google / GitHub sign-in for the desktop app, run in the user's own browser
// (Google won't sign in inside an embedded web view). The app opens this page;
// it signs in with Firebase and posts the ID token back to the app's one-time
// listener on 127.0.0.1:<port>, tagged with the app's random <state>. Firebase's
// web config comes from the environment (FIREBASE_*).
pub async fn social_auth(template: web::Data<Tera>, query: web::Query<SocialAuthQuery>) -> Result<HttpResponse, Error> {
    let provider = match query.provider.as_str() {
        "google" => ("google", "Google"),
        "github" => ("github", "GitHub"),
        _ => return Ok(HttpResponse::BadRequest().body("Unknown sign-in provider")),
    };
    let state_ok = (16..=64).contains(&query.state.len()) && query.state.chars().all(|c| c.is_ascii_hexdigit());
    if query.port < 1024 || !state_ok {
        return Ok(HttpResponse::BadRequest().body("Invalid sign-in link — start again from the Scaffold app"));
    }

    let var = |k: &str| std::env::var(k).unwrap_or_default().trim().to_string();
    let firebase = serde_json::json!({
        "apiKey": var("FIREBASE_WEB_API_KEY"),
        "authDomain": var("FIREBASE_AUTH_DOMAIN"),
        "projectId": var("FIREBASE_PROJECT_ID"),
        "appId": var("FIREBASE_APP_ID"),
    });
    let configured = ["apiKey", "authDomain", "projectId"].iter().all(|k| !firebase[*k].as_str().unwrap_or("").is_empty());

    let mut ctx = Context::new();
    ctx.insert("provider", provider.0);
    ctx.insert("provider_label", provider.1);
    ctx.insert("port", &query.port);
    ctx.insert("state", &query.state);
    ctx.insert("configured", &configured);
    ctx.insert("firebase", &firebase);
    let html = template
        .render("social-auth.html", &ctx)
        .map_err(|e| error::ErrorInternalServerError(e))?;
    Ok(HttpResponse::Ok()
        .content_type("text/html")
        .append_header(("Cache-Control", "no-store"))
        .append_header(("Referrer-Policy", "no-referrer"))
        .body(html))
}

// Sign in, the dashboard and the editor live in the desktop app now. Old links
// to those pages land on the landing page's download section instead.
pub async fn desktop_only() -> HttpResponse {
    HttpResponse::Found()
        .append_header(("Location", "/#download"))
        .finish()
}
