// use actix::Actor;
use actix::Actor;
use actix_files as StaticResource;
use actix_session::config::{CookieContentSecurity, PersistentSession, TtlExtensionPolicy};
use actix_session::{SessionMiddleware, storage::RedisActorSessionStore};
use actix_web::{
    App, HttpResponse, HttpServer, cookie::Key, cookie::SameSite, cookie::time::Duration, dev,
    dev::Service, error, http, middleware as ActixMiddleware, web,
};
use dotenv::dotenv as App_env;
use futures_util::future::{self, Either, FutureExt};
use listenfd::ListenFd;
use std::{env, io};
use tera::{Context, Tera};

mod builtins;
use builtins as BuiltIns;

mod model;
use model as Model;

mod middleware;
use middleware as Middleware;

mod utils;
use utils as Utils;

mod routes;
use routes as Routes;

mod integrations;
use integrations as Integrations;

mod handler;
use handler as Handler;

mod markup;
use markup as Markup;

// Hi how are you
/// The public origin a redirect should point at, built from the host the
/// request arrived with.
///
/// No port, ever. Behind nginx this app binds a private port (445) that the
/// outside world is not supposed to see, and a redirect that named it sent
/// visitors to `https://scaffold.sabbirhassan.com:445/` — the app's own bind
/// address wearing the public hostname. `connection_info().host()` is the
/// right source because it prefers a proxy's `X-Forwarded-Host` over the
/// socket, but it still carries whatever port came with it, so the port is
/// dropped here rather than trusted.
///
/// Dropping it resolves to 443, which is the only port a canonical https URL
/// should name. Serving https on some other port without a proxy in front is
/// therefore not supported by this redirect — that is what `APP_HTTP=allow`
/// is for in development, and it short-circuits the whole thing.
fn canonical_origin(host: &str) -> String {
    let host = host.split(':').next().unwrap_or(host);
    format!("https://{}", host)
}

#[actix_web::main]
async fn main() -> io::Result<()> {
    // The single, shared collaboration Lobby actor. Its Addr is cheap to clone and
    // points at this one instance, so every worker thread talks to the same room
    // registry (never build it inside the App factory — that yields one per worker).
    let lobby = Handler::Collab::Lobby::Lobby::default().start();

    /*
    Loads environment variables from `.env` file to `std::env`
    */
    App_env().ok();

    /*
    Use with log::info!() | log::warn!() | log::error!()
    */
    let _logger = BuiltIns::logger::init();

    /*
    RUNS CORN JOB FOR YOUR PROJECT
    Remove the following code block if you are not using this feature.
    */
    /*  tokio::spawn(async move {
            use tokio::time::{self, Duration};
            let mut interval = time::interval(Duration::from_secs(60));
            loop {
            interval.tick().await;

                /*
                Execute your desired CORN routines here.
                */
                BuiltIn::cron::greet().await;
            }
        });
    */

    /*
        Sqlite Database Initialization
        Remove the following code block if you are not using this feature.
    */
    log::info!("\nExecuting Sqlite3 Prerequisites...");
    BuiltIns::sqlite::create_initial_tables().expect("Failed to initiate!\n");

    log::info!("\nEnsuring MongoDB indexes...");
    BuiltIns::mongo::MongoDB.ensure_indexes().await;

    let mut listenfd = ListenFd::from_env();

    let host = env::var("APP_HOST").expect("APP_HOST must be set on .env file");
    let http_port = env::var("APP_HTTP_PORT").expect("APP_HTTP_PORT must be set on .env file");
    let https_port = env::var("APP_HTTPS_PORT").expect("APP_HTTPS_PORT must be set on .env file");

    let redis_host = env::var("REDIS_HOST").expect("REDIS_HOST must be set on .env file");
    let redis_port = env::var("REDIS_PORT").expect("REDIS_PORT must be set on .env file");
    let redis_server = format!("{}:{}", redis_host, redis_port);

    /*
        Use a unique private key for every project.
        Anyone with access to the key can generate authentication cookies
        For any user on the system, which will compromise the authentication system!
    */
    let private_key = env::var("SESSION_KEY").expect("SESSION_KEY must be set on .env file");

    let http_server = HttpServer::new(move || {
        /*
        IMPORTANT:
        Do not create any global data such as web::Data<T> here
        Multi CPU machine can spawn multiple thread and will create multiple global instance of such data.
        */

        App::new()
            .app_data(web::Data::new(lobby.clone()))
            .wrap_fn(|sreq, srv| {
                let app_http = env::var("APP_HTTP").expect("APP_HTTP must be set on .env file");

                /*
                  Redirects request from HTTP to HTTPS.

                  The scheme comes from connection_info, which reads
                  X-Forwarded-Proto ahead of the socket — so behind nginx this
                  fires on what the *visitor* used, not on the TLS hop between
                  nginx and this process.

                  It used to build the target as host + APP_HTTPS_PORT, which
                  is this process's own bind port. Served directly that was
                  right; behind a reverse proxy it published the private port,
                  and every plain-http visitor was answered with
                  https://scaffold.sabbirhassan.com:445/. See canonical_origin.
                */
                if app_http.to_owned() == "allow" || sreq.connection_info().scheme() == "https" {
                    Either::Left(srv.call(sreq).map(|res| res))
                } else {
                    let host = sreq.connection_info().host().to_owned();
                    let uri = sreq.uri().to_owned();
                    let url = format!("{}{}", canonical_origin(&host), uri);

                    return Either::Right(future::ready(Ok(sreq.into_response(
                        HttpResponse::MovedPermanently()
                            .append_header((http::header::LOCATION, url))
                            .finish(),
                    ))));
                }
            })
            .wrap_fn(move |req, srv| {
                /*
                  301 - Moved Permanently | URL Canonicalization

                  www and the apex are one site, and a search engine that can
                  reach both has to guess which is canonical, splitting
                  whatever authority the domain has earned between two hosts.

                  This used to run on the response and test
                  request.uri().to_string() for the substring "https://www.",
                  which never matched: a server-side URI is origin-form —
                  "/about" — with no scheme and no host in it at all. The
                  check silently passed everything through, so both hosts
                  answered 200 and this code had never once fired.

                  The host now comes from connection_info, which prefers a
                  proxy's X-Forwarded-Host over the socket, and the redirect
                  happens before the handler runs rather than after rendering
                  a response and throwing it away.
                */
                let app_http = env::var("APP_HTTP").expect("APP_HTTP must be set on .env file");
                let host = req.connection_info().host().to_owned();

                if app_http.to_owned() == "allow" || !host.starts_with("www.") {
                    return Either::Left(srv.call(req).map(|res| res));
                }

                let apex = host.trim_start_matches("www.").to_owned();
                let path = req
                    .uri()
                    .path_and_query()
                    .map(|p| p.as_str().to_owned())
                    .unwrap_or_else(|| "/".to_owned());
                let url = format!("{}{}", canonical_origin(&apex), path);

                Either::Right(future::ready(Ok(req.into_response(
                    HttpResponse::MovedPermanently()
                        .append_header((http::header::LOCATION, url))
                        .finish(),
                ))))
            })
            .app_data(web::Data::new(Tera::new("pages/**/*").unwrap()))
            .wrap_fn(move |req, srv| {
                /* Custom Error Page Handler */
                srv.call(req).map(|res| {
                    if let Ok(response) = &res {
                        let request = response.request();

                        if response.status() == http::StatusCode::NOT_FOUND
                            && request.method() == http::Method::GET
                        {
                            // 👇 Skip API routes (or any route returning JSON)
                            let path = request.path();
                            let accept_header = request
                                .headers()
                                .get("accept")
                                .and_then(|v| v.to_str().ok())
                                .unwrap_or("");

                            if path.starts_with("/api")
                                || path.starts_with("/image")
                                || accept_header.contains("application/json")
                            {
                                // Don’t override JSON API 404s
                                return res;
                            }

                            let tera = request.app_data::<web::Data<Tera>>();
                            let template = tera.unwrap();
                            let ctx = Context::new();

                            let res_data = template
                                .render("error/not_found.html", &ctx)
                                .map_err(|e| error::ErrorInternalServerError(e))
                                .unwrap();

                            return Ok(dev::ServiceResponse::new(
                                request.clone(),
                                HttpResponse::NotFound()
                                    .content_type("text/html")
                                    .body(res_data),
                            ));
                        }
                    }
                    res
                })
            })
            .wrap(
                /*
                  Redis session manager based on Cookie
                  Session data gets removed automatically from database when TTL expires.

                  Visit the following link for User Manual
                  https://docs.rs/actix-session/0.7.2/actix_session/struct.Session.html
                */
                SessionMiddleware::builder(
                    RedisActorSessionStore::new(&redis_server),
                    Key::derive_from(&private_key.as_bytes()),
                )
                .cookie_secure(false)
                .cookie_http_only(true)
                .cookie_name("um-sid-velora".to_owned())
                .cookie_same_site(SameSite::None)
                .cookie_content_security(CookieContentSecurity::Signed)
                .session_lifecycle(
                    PersistentSession::default()
                        .session_ttl(Duration::days(15))
                        .session_ttl_extension_policy(TtlExtensionPolicy::OnStateChanges),
                )
                .build(),
            )
            .wrap(BuiltIns::cors::get_policy())
            .wrap(ActixMiddleware::Compress::default())
            /* Custom HTTP Headers */
            .wrap(ActixMiddleware::DefaultHeaders::new().add(("X-Signature", "sabbir")))
            .wrap(ActixMiddleware::DefaultHeaders::new().add(("X-Frame-Options", "DENY")))
            .wrap(
                ActixMiddleware::DefaultHeaders::new()
                    .add(("Referrer-Policy", "strict-origin-when-cross-origin")),
            )
            .wrap(ActixMiddleware::DefaultHeaders::new().add(BuiltIns::csp::get_policy()))
            .service(
                StaticResource::Files::new("/assets/", "assets/")
                    .prefer_utf8(true)
                    .use_last_modified(true),
            )
            .wrap_fn(|req, srv| {
                /* Custom CACHE_CONTROL for Resources.
                   In development (APP_HTTP="allow") we send "no-cache" so edited
                   CSS/JS is always revalidated and never served stale; in
                   production we cache aggressively for 24h. */
                srv.call(req).map(|mut res| {
                    if let Ok(response) = &mut res {
                        let request = response.request();
                        let uri = request.uri().to_string();
                        if uri.contains("/assets/") {
                            let dev = env::var("APP_HTTP").map(|v| v == "allow").unwrap_or(false);
                            let cache = if dev {
                                "no-cache"
                            } else {
                                "public, max-age=86400, must-revalidate"
                            };
                            response.headers_mut().insert(
                                http::header::CACHE_CONTROL,
                                http::header::HeaderValue::from_static(cache),
                            );
                        }
                    }
                    res
                })
            })
            // Desktop installers: GET /downloads/{file} (routes/pages.rs → handler/download.rs).
            .service(
                StaticResource::Files::new("/components/", "components/")
                    .prefer_utf8(true)
                    .use_last_modified(true),
            )
            .wrap_fn(|req, srv| {
                /* Custom CACHE_CONTROL for Resources — see /assets/ block above. */
                srv.call(req).map(|mut res| {
                    if let Ok(response) = &mut res {
                        let request = response.request();
                        let uri = request.uri().to_string();
                        if uri.contains("/components/") {
                            let dev = env::var("APP_HTTP").map(|v| v == "allow").unwrap_or(false);
                            let cache = if dev {
                                "no-cache"
                            } else {
                                "public, max-age=86400, must-revalidate"
                            };
                            response.headers_mut().insert(
                                http::header::CACHE_CONTROL,
                                http::header::HeaderValue::from_static(cache),
                            );
                        }
                    }
                    res
                })
            })
            .configure(Routes::Auth::router)
            .configure(Routes::Project::router)
            .configure(Routes::Collab::router)
            .configure(Routes::Ai::router)
            .configure(Routes::Feedback::router)
            .configure(Routes::Image::router)
            .configure(Routes::Public::router)
            .configure(Routes::Pages::router)
    });

    let http_server = if let Some(listener) = listenfd.take_tcp_listener(0)? {
        http_server.listen(listener)?
    } else {
        http_server.bind((host.as_str(), http_port.parse::<u16>().unwrap()))?
    };

    let http_server = if let Some(listener) = listenfd.take_tcp_listener(1)? {
        http_server.listen_rustls(listener, BuiltIns::tls::init())?
    } else {
        http_server.bind_rustls(&format!("{host}:{https_port}"), BuiltIns::tls::init())?
    };

    http_server.run().await
}

#[cfg(test)]
mod tests {
    use super::canonical_origin;

    #[test]
    fn drops_the_apps_own_bind_port() {
        // The bug this function exists for: behind nginx the redirect named
        // the private port the app binds, not the address visitors use.
        assert_eq!(
            canonical_origin("scaffold.sabbirhassan.com:445"),
            "https://scaffold.sabbirhassan.com"
        );
    }

    #[test]
    fn leaves_a_portless_host_alone() {
        assert_eq!(
            canonical_origin("scaffold.sabbirhassan.com"),
            "https://scaffold.sabbirhassan.com"
        );
    }

    #[test]
    fn upgrades_the_scheme_not_just_the_port() {
        // The caller passes a bare host; the https is this function's doing.
        assert!(canonical_origin("example.test:80").starts_with("https://"));
    }

    #[test]
    fn handles_a_host_that_is_only_a_port_or_empty() {
        // Nothing should panic on a malformed Host header.
        assert_eq!(canonical_origin(""), "https://");
        assert_eq!(canonical_origin(":445"), "https://");
    }
}
