use serde::{Deserialize, Serialize};
use serde_json::Value;
use super::ImageStruct;

// Access level a collaborator holds on a project (least → most privileged).
// Mirrors the editor's share roles (see assets/js/shares.js).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ProjectRole { Viewer, Editor, Owner }
impl std::fmt::Display for ProjectRole {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(fmt, "{:?}", self)
    }
}

// Lifecycle of a collaboration invite.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum ShareStatus { Pending, Accepted, Declined }
impl std::fmt::Display for ShareStatus {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(fmt, "{:?}", self)
    }
}

// How a collaborator record came to be. `Invite` = the owner invited someone
// (the invitee accepts). `Request` = an outsider asked for access (the owner
// accepts). Both resolve to an Accepted record that grants access.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum CollaboratorKind { Invite, Request }
impl Default for CollaboratorKind {
    fn default() -> Self { CollaboratorKind::Invite }
}
impl std::fmt::Display for CollaboratorKind {
    fn fmt(&self, fmt: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(fmt, "{:?}", self)
    }
}

// project_core — a project's metadata (one document per project). Kept separate
// from the heavy design document so listing/searching projects on the dashboard
// never has to load the full canvas.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectCore {
    pub uuid: String,
    pub owner_id: String,               // account uuid of the creator / owner
    pub name: String,
    pub description: Option<String>,
    // snake_case identity derived from the name, used as the generated Dart
    // package/route base (e.g. "Mobile Banking App" → "mobile_banking_app").
    pub slug: String,
    // Dashboard card thumbnail: a two-stop gradient, with an optional rendered
    // preview image that supersedes the gradient once available.
    pub thumbnail_from: String,         // hex, e.g. "#5b8af5"
    pub thumbnail_to: String,           // hex, e.g. "#3d6de0"
    pub thumbnail_image: Option<ImageStruct>,

    pub created_at: i64,                 // epoch millis
    pub modified_at: i64,                // bumped whenever the document is saved
    pub archived_at: Option<i64>,        // soft-delete marker (None = active)

    // Public view link: anyone with /view/<token> can see the design read-only.
    // None = no public link. Only ever returned to the owner; turning the link off
    // clears it, so an old link stops working. `default` keeps older records valid.
    #[serde(default)]
    pub public_token: Option<String>,
}

// project_document — the design itself (canvas nodes, colors, typography, themes,
// data models, providers…). Its schema is owned and evolved by the editor
// frontend, which serializes its whole state, so it is stored as a flexible BSON
// document rather than a fixed Rust shape. One document per project. Stored as a
// serde_json::Value (not bson::Document) so it round-trips through the API as
// plain JSON instead of MongoDB Extended JSON.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectDocument {
    pub uuid: String,
    pub project_id: String,              // == the project uuid it belongs to
    pub content: Value,                  // serialized editor state (frontend-owned schema)
    pub version: i64,                    // incremented per save (optimistic concurrency)
    pub modified_at: i64,                // epoch millis
    pub modified_by: String,             // account uuid of the last editor
}

// project_collaborator — one sharing record / invite per (project, invitee).
// Mirrors the editor's invite flow: an email is invited at a role and the invite
// is pending until accepted or declined. `user_id` is filled once the invitee
// has (or gets) an account; a purely-email invite keeps it None until then.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectCollaborator {
    pub uuid: String,
    pub project_id: String,
    pub user_id: Option<String>,         // invitee's account uuid, once known
    pub email_address: String,
    pub role: ProjectRole,
    pub status: ShareStatus,
    // Invite (owner invited them) vs Request (they asked for access). `default`
    // keeps older records — created before this field existed — deserializing as
    // invites.
    #[serde(default)]
    pub kind: CollaboratorKind,
    pub invited_by: String,              // account uuid that sent the invite (or the requester, for a Request)

    pub created_at: i64,                 // epoch millis
    pub responded_at: Option<i64>,       // when accepted/declined (None while pending)
}

// project_user_state — one document per (user, project). Holds a caller's
// *personal* view of a project that must never be shared with other members:
// pinning, last-opened, personal ordering, etc. Pinning lives here (not on
// project_core) so that a project shared among several people can be pinned by
// one member without affecting anyone else's dashboard.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectUserState {
    pub uuid: String,
    pub user_id: String,
    pub project_id: String,
    pub pinned: bool,
    pub last_opened_at: Option<i64>,     // future: "recently opened" sorting (None = never here)

    pub created_at: i64,                 // epoch millis
    pub modified_at: i64,                // bumped whenever this personal state changes
}

// One message within a comment thread. `author_name` is denormalised (copied from
// the account's profile at write time) so listing a thread needs no extra lookups.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct CommentMessage {
    pub uuid: String,
    pub author_id: String,               // account uuid of the message's author
    pub author_name: String,
    pub text: String,
    pub created_at: i64,                 // epoch millis
}

// project_comment — one Figma-style comment thread pinned to a world coordinate on
// the canvas. Kept out of the design document so annotations don't ride the design's
// versioning / undo history and every member can add to them independently.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ProjectComment {
    pub uuid: String,
    pub project_id: String,
    pub x: f64,                          // world coordinates of the pin
    pub y: f64,
    pub resolved: bool,
    pub created_by: String,              // account uuid that started the thread
    pub messages: Vec<CommentMessage>,

    pub created_at: i64,                 // epoch millis
    pub modified_at: i64,                // bumped on every reply / resolve toggle
}
