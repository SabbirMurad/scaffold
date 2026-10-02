// The per-connection WebSocket actor. One WsConn exists for each open editor tab.
// It relays the client's committed `doc_update` messages to the Lobby (which
// persists + fans them out) and forwards Lobby messages back down the socket. A
// heartbeat drops dead connections.

use std::time::{Duration, Instant};

use actix::{Actor, ActorContext, Addr, AsyncContext, Handler, Running, StreamHandler};
use actix_http::ws::Item;
use actix_web_actors::ws;
use serde_json::Value;

use super::lobby::Lobby;
use super::messages::{Connect, Disconnect, DocUpdate, WsMessage};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const CLIENT_TIMEOUT: Duration = Duration::from_secs(12);
// The most a message split across continuation frames may add up to — the same
// limit as a single frame (connect.rs MAX_FRAME).
const MAX_MESSAGE: usize = 16 * 1024 * 1024;

pub struct WsConn {
    project_id: String,
    conn_id: String,
    user_id: String,
    can_edit: bool, // viewers may receive updates but their edits are ignored
    lobby: Addr<Lobby>,
    hb: Instant,
    // A text message arriving in pieces (continuation frames), until its last one.
    partial: Option<Vec<u8>>,
}

impl WsConn {
    pub fn new(
        project_id: String,
        conn_id: String,
        user_id: String,
        can_edit: bool,
        lobby: Addr<Lobby>,
    ) -> Self {
        Self {
            project_id,
            conn_id,
            user_id,
            can_edit,
            lobby,
            hb: Instant::now(),
            partial: None,
        }
    }

    fn heartbeat(&self, ctx: &mut ws::WebsocketContext<Self>) {
        ctx.run_interval(HEARTBEAT_INTERVAL, |act, ctx| {
            if Instant::now().duration_since(act.hb) > CLIENT_TIMEOUT {
                ctx.stop();
                return;
            }
            ctx.ping(b"");
        });
    }

    fn on_text(&mut self, raw: String) {
        let value: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(_) => return,
        };
        let msg_type = value.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if msg_type == "doc_update" {
            if !self.can_edit {
                return; // a viewer can't change the document
            }
            let slices = value
                .get("payload")
                .and_then(|payload| payload.get("slices"))
                .cloned()
                .unwrap_or(Value::Null);
            if !slices.is_object() {
                return;
            }
            self.lobby.do_send(DocUpdate {
                project_id: self.project_id.clone(),
                conn_id: self.conn_id.clone(),
                user_id: self.user_id.clone(),
                slices,
            });
        }
    }
}

impl Actor for WsConn {
    type Context = ws::WebsocketContext<Self>;

    fn started(&mut self, ctx: &mut Self::Context) {
        self.heartbeat(ctx);
        self.lobby.do_send(Connect {
            addr: ctx.address().recipient(),
            project_id: self.project_id.clone(),
            conn_id: self.conn_id.clone(),
            user_id: self.user_id.clone(),
        });
    }

    fn stopping(&mut self, _ctx: &mut Self::Context) -> Running {
        self.lobby.do_send(Disconnect {
            project_id: self.project_id.clone(),
            conn_id: self.conn_id.clone(),
            user_id: self.user_id.clone(),
        });
        Running::Stop
    }
}

impl StreamHandler<Result<ws::Message, ws::ProtocolError>> for WsConn {
    fn handle(&mut self, msg: Result<ws::Message, ws::ProtocolError>, ctx: &mut Self::Context) {
        match msg {
            Ok(ws::Message::Ping(payload)) => {
                self.hb = Instant::now();
                ctx.pong(&payload);
            }
            Ok(ws::Message::Pong(_)) => {
                self.hb = Instant::now();
            }
            Ok(ws::Message::Text(text)) => {
                self.hb = Instant::now();
                self.on_text(text.to_string());
            }
            Ok(ws::Message::Binary(_)) => {}
            Ok(ws::Message::Close(reason)) => {
                ctx.close(reason);
                ctx.stop();
            }
            // A large message (e.g. a doc_update carrying a big design) arrives
            // split into frames: collect them, and handle the whole once complete.
            Ok(ws::Message::Continuation(item)) => {
                self.hb = Instant::now();
                let last = matches!(item, Item::Last(_));
                match item {
                    Item::FirstText(bytes) => self.partial = Some(bytes.to_vec()),
                    Item::FirstBinary(_) => self.partial = None, // binary isn't used
                    Item::Continue(bytes) | Item::Last(bytes) => {
                        let Some(buf) = self.partial.as_mut() else { return };
                        buf.extend_from_slice(&bytes);
                        if buf.len() > MAX_MESSAGE {
                            log::error!("ws message over {MAX_MESSAGE} bytes; dropping the connection");
                            ctx.stop();
                            return;
                        }
                        if last {
                            let whole = self.partial.take().unwrap_or_default();
                            match String::from_utf8(whole) {
                                Ok(text) => self.on_text(text),
                                Err(_) => log::error!("ws continuation message isn't valid UTF-8"),
                            }
                        }
                    }
                }
            }
            Ok(ws::Message::Nop) => {}
            Err(error) => {
                log::error!("ws stream error: {:?}", error);
                ctx.stop();
            }
        }
    }
}

impl Handler<WsMessage> for WsConn {
    type Result = ();

    fn handle(&mut self, msg: WsMessage, ctx: &mut Self::Context) {
        ctx.text(msg.0);
    }
}
