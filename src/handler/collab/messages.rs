// Actor messages for the real-time collaboration layer. The wire protocol is a
// tiny JSON envelope `{ "type": ..., "payload": ... }`; these structs are the
// in-process messages the WebSocket connection actor sends to the Lobby.

use actix::prelude::{Message, Recipient};
use serde_json::Value;

// A ready-to-send text frame handed to a single connection's socket.
#[derive(Message)]
#[rtype(result = "()")]
pub struct WsMessage(pub String);

// A connection joined a project room.
#[derive(Message)]
#[rtype(result = "()")]
pub struct Connect {
    pub addr: Recipient<WsMessage>,
    pub project_id: String,
    pub conn_id: String,
    pub user_id: String,
}

// A connection left a project room (closed tab, dropped socket, timeout).
#[derive(Message)]
#[rtype(result = "()")]
pub struct Disconnect {
    pub project_id: String,
    pub conn_id: String,
    pub user_id: String,
}

// A committed document change: the editor finished an action (move/edit/etc.) and
// sent the slices that changed. The Lobby persists them and fans them out to the
// room's other connections. `conn_id` is the sender, excluded from the fan-out.
#[derive(Message)]
#[rtype(result = "()")]
pub struct DocUpdate {
    pub project_id: String,
    pub conn_id: String,
    pub user_id: String,
    pub slices: Value,
}
