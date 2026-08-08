// Real-time collaboration over WebSocket. `Lobby` is the shared room registry,
// `WsConn` a single connection, `messages` the in-process actor messages, and
// `connect` the HTTP → WS upgrade handler.

pub mod messages;

pub mod lobby;
pub use lobby as Lobby;

pub mod session;

pub mod connect;
pub use connect as Connect;
