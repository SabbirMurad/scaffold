use std::env;
use rusqlite::{Connection, Result, Error};

/*
  For Loading Dynamic Database
  Add / Remove fields based on your project needs!
*/
pub enum DBF { IMG, JWT }

pub fn connect(dbf: DBF) -> Result<Connection, Error> {
    let db_path = match dbf {
        DBF::IMG => {
            env::var("SQLITE_IMG_PATH")
            .expect("SQLITE_IMG_PATH must be set on .env file")
        }
        DBF::JWT => {
            env::var("SQLITE_JWT_PATH")
            .expect("SQLITE_JWT_PATH must be set on .env file")
        }
    };

    Ok(Connection::open(db_path)?)
}

pub fn create_initial_tables() -> Result<(), Error> {
    /* Following table is for storing images */
    let db_path = env::var("SQLITE_IMG_PATH")
        .expect("SQLITE_IMG_PATH must be set on .env file");

    let db_conn = Connection::open(db_path)?;
    // Design images: raw bytes live here; the Mongo design document only stores a
    // reference (the uuid). `project_id` scopes each image to its project so the
    // serve endpoint can gate access by project membership.
    let _result = db_conn.execute(
        "CREATE TABLE IF NOT EXISTS image (
            uuid          TEXT PRIMARY KEY,
            project_id    TEXT NOT NULL,
            mime          TEXT NOT NULL,
            bytes         BLOB NOT NULL,
            width         INTEGER NOT NULL,
            height        INTEGER NOT NULL,
            created_at    INTEGER NOT NULL
        );", ()
    )?;
    // Bulk lookups / cleanup by project (e.g. deleting a project's images).
    let _result = db_conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_image_project ON image(project_id);", ()
    )?;

    let _result = db_conn.execute(
        "CREATE TABLE IF NOT EXISTS emoji (
            uuid          TEXT PRIMARY KEY,
            original      BLOB NOT NULL,
            webp          BLOB NOT NULL
        );", ()
    )?;


    /* Following table is for JWT Refresh Token */
    let db_path = env::var("SQLITE_JWT_PATH")
        .expect("SQLITE_JWT_PATH must be set on .env file");

    let db_conn = Connection::open(db_path)?;
    let _result = db_conn.execute(
        "CREATE TABLE IF NOT EXISTS refreshToken (
            issuer          TEXT PRIMARY KEY,
            token           TEXT,
            status          TEXT,
            created_at      INTEGER,
            modified_at     INTEGER
        );", ()
    )?;

    Ok(())
}