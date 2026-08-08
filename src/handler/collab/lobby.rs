// The Lobby actor: a single in-process registry of every open editor connection,
// grouped into project "rooms". It fans committed document changes out to a
// project's other connections and persists them to Mongo (last-write-wins per
// slice). One Lobby instance is shared across the whole server (see main.rs).

use std::collections::HashMap;

use actix::prelude::{Actor, Context, Handler, Recipient};
use chrono::Utc;
use mongodb::bson::{doc, to_bson, Document};
use serde_json::{json, Value};

use crate::BuiltIns::mongo::MongoDB;
use crate::Model::Project::{ProjectCore, ProjectDocument};

use super::messages::{Connect, Disconnect, DocUpdate, WsMessage};

pub type Socket = Recipient<WsMessage>;

#[derive(Default)]
pub struct Lobby {
    // project_id → (conn_id → (socket, user_id))
    rooms: HashMap<String, HashMap<String, (Socket, String)>>,
}

impl Actor for Lobby {
    type Context = Context<Self>;
}

impl Lobby {
    // Send a pre-serialized frame to every connection in a room except the sender.
    fn broadcast(&self, project_id: &str, except_conn: &str, text: &str) {
        if let Some(conns) = self.rooms.get(project_id) {
            for (conn_id, (socket, _user_id)) in conns.iter() {
                if conn_id != except_conn {
                    let _ = socket.do_send(WsMessage(text.to_string()));
                }
            }
        }
    }

    // Tell everyone in a room who is currently connected (distinct user ids), so
    // clients can show a "others are here" indicator.
    fn broadcast_presence(&self, project_id: &str) {
        let conns = match self.rooms.get(project_id) {
            Some(conns) => conns,
            None => return,
        };
        let mut users: Vec<String> = conns.values().map(|(_, user_id)| user_id.clone()).collect();
        users.sort();
        users.dedup();
        let text = json!({ "type": "presence", "payload": { "users": users } }).to_string();
        for (_conn_id, (socket, _user_id)) in conns.iter() {
            let _ = socket.do_send(WsMessage(text.clone()));
        }
    }
}

impl Handler<Connect> for Lobby {
    type Result = ();

    fn handle(&mut self, msg: Connect, _ctx: &mut Self::Context) {
        self.rooms
            .entry(msg.project_id.clone())
            .or_default()
            .insert(msg.conn_id.clone(), (msg.addr, msg.user_id.clone()));
        self.broadcast_presence(&msg.project_id);
    }
}

impl Handler<Disconnect> for Lobby {
    type Result = ();

    fn handle(&mut self, msg: Disconnect, _ctx: &mut Self::Context) {
        if let Some(conns) = self.rooms.get_mut(&msg.project_id) {
            conns.remove(&msg.conn_id);
            if conns.is_empty() {
                self.rooms.remove(&msg.project_id);
                return;
            }
        }
        self.broadcast_presence(&msg.project_id);
    }
}

impl Handler<DocUpdate> for Lobby {
    type Result = ();

    fn handle(&mut self, msg: DocUpdate, _ctx: &mut Self::Context) {
        // 1) Fan out to the room immediately — low latency is the whole point.
        let envelope = json!({
            "type": "doc_update",
            "payload": { "slices": msg.slices, "from": msg.user_id }
        })
        .to_string();
        self.broadcast(&msg.project_id, &msg.conn_id, &envelope);

        // 2) Persist in the background so a reload / a late joiner sees the change.
        let project_id = msg.project_id.clone();
        let user_id = msg.user_id.clone();
        let slices = msg.slices.clone();
        actix::spawn(async move {
            persist_slices(project_id, slices, user_id).await;
        });
    }
}

// Merge the changed slices into the stored document (`content.<slice>`), bump the
// version, and touch the project's modified timestamps. Mirrors the HTTP save
// handler's merge, minus the optimistic-lock check (real-time is last-write-wins).
async fn persist_slices(project_id: String, slices: Value, user_id: String) {
    let map = match slices.as_object() {
        Some(map) => map,
        None => return,
    };

    let now = Utc::now().timestamp_millis();
    let db = MongoDB.connect();

    let mut set = Document::new();
    for (slice, value) in map {
        match to_bson(value) {
            Ok(bson) => {
                set.insert(format!("content.{slice}"), bson);
            }
            Err(error) => {
                log::error!("collab persist to_bson: {:?}", error);
                return;
            }
        }
    }
    set.insert("modified_at", now);
    set.insert("modified_by", &user_id);

    let result = db
        .collection::<ProjectDocument>("project_document")
        .update_one(
            doc! { "project_id": &project_id },
            doc! { "$set": set, "$inc": { "version": 1 } },
        )
        .await;

    if let Err(error) = result {
        log::error!("collab persist: {:?}", error);
        return;
    }

    // Keep the project's modified_at in step so the dashboard sorts correctly.
    let _ = db
        .collection::<ProjectCore>("project_core")
        .update_one(
            doc! { "uuid": &project_id },
            doc! { "$set": { "modified_at": now } },
        )
        .await;
}
