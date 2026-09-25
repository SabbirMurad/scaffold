use std::env;
use actix_cors::Cors;

/*
  Cross-Origin Resource Sharing (CORS)
  An HTTP-header based mechanism that allows a server to indicate any origins (domain, scheme, or port) other than its own from which a browser should permit loading resources.

  Visit: https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS

  In Plain English:
  Let's say, this server is for `foo.com`
  The following `allowed_origin()` indicate that only
  The listed FQDN are allowed to make `JavaScript API` calls
  Such as `XHR` or `fetch()` request to the `foo.com`
  Otherwise, leave it as it is
*/

pub fn get_policy() -> Cors {
    let mode = env::var("APP_STAGE")
        .expect("APP_STAGE must be set on .env file");

    if mode == "development" { Cors::permissive() }
    else {
        // Replace the Origin names with targeted FQDN
        // You can also add more constraints if needed
        Cors::default()
            // .allowed_origin("https://example.com")
            .allowed_origin("https://sabbirhassan.com:444")
            .allowed_origin("https://www.sabbirhassan.com:444")
            // The desktop (Tauri) app's webview origins: macOS/Linux, then Windows.
            .allowed_origin("tauri://localhost")
            .allowed_origin("http://tauri.localhost")
            .allowed_origin("https://tauri.localhost")
            .allow_any_header()
            .allow_any_method()
            .supports_credentials()
            .max_age(3600)
    }
}
