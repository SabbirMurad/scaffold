// WebSocket upgrade endpoint for the collaboration channel. A browser can't set
// an Authorization header on a WS handshake, so the access token arrives as a
// `?token=` query parameter; it's verified here, project access is checked, and
// then the socket is handed to a WsConn actor bound to the project room.

use actix::Addr;
use actix_web::{
    web::{self, Data, Payload},
    Error, HttpRequest, HttpResponse,
};
use actix_web_actors::ws;
use uuid::Uuid;

use crate::BuiltIns::{jwt, mongo::MongoDB};
use crate::Handler::Project;
use crate::Model::Project::ProjectRole;

use super::lobby::Lobby;

// Largest message a socket accepts. A change carries whole document slices, and a
// real design's `nodes` slice passes the library's 64 KB default — which dropped
// the connection on every save of a larger project.
const MAX_FRAME: usize = 16 * 1024 * 1024;
use super::session::WsConn;

pub async fn task(
    req: HttpRequest,
    stream: Payload,
    path: web::Path<String>,
    srv: Data<Addr<Lobby>>,
) -> Result<HttpResponse, Error> {
    let project_id = path.into_inner();

    // The token rides in the query string (JWTs are URL-safe, so no decoding).
    let token = req
        .query_string()
        .split('&')
        .find_map(|pair| pair.strip_prefix("token="))
        .unwrap_or("");
    if token.is_empty() {
        return Ok(HttpResponse::Unauthorized().finish());
    }

    let claims = match jwt::access_token::verify(token, jwt::Key::Local) {
        Ok(claims) => claims,
        Err(error) => {
            log::error!("ws auth: {:?}", error);
            return Ok(HttpResponse::Unauthorized().finish());
        }
    };
    let user_id = claims.sub;

    // Must be at least a viewer on this project to join its room.
    let db = MongoDB.connect();
    let (_core, role) = match Project::access(&db, &project_id, &user_id).await {
        Ok(result) => result,
        Err(_response) => return Ok(HttpResponse::Forbidden().finish()),
    };
    let can_edit = Project::role_rank(&role) >= Project::role_rank(&ProjectRole::Editor);

    let conn = WsConn::new(
        project_id,
        Uuid::new_v4().to_string(),
        user_id,
        can_edit,
        srv.get_ref().clone(),
    );

    ws::WsResponseBuilder::new(conn, &req, stream).frame_size(MAX_FRAME).start()
}

// A public view link joins the project's room receive-only: it sees every change
// live, and anything it sends is ignored (can_edit = false).
pub async fn public_task(
    req: HttpRequest,
    stream: Payload,
    path: web::Path<String>,
    srv: Data<Addr<Lobby>>,
) -> Result<HttpResponse, Error> {
    let db = MongoDB.connect();
    let core = match crate::Handler::Public::project_by_token(&db, &path.into_inner()).await {
        Ok(core) => core,
        Err(_response) => return Ok(HttpResponse::NotFound().finish()),
    };
    let conn = WsConn::new(
        core.uuid,
        Uuid::new_v4().to_string(),
        "public".to_string(),
        false,
        srv.get_ref().clone(),
    );
    ws::WsResponseBuilder::new(conn, &req, stream).frame_size(MAX_FRAME).start()
}
