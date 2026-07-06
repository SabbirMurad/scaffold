use std::env;
use std::time::Duration;
use mongodb::bson::{ doc, Document };
use mongodb::{ Client, ClientSession, Database, IndexModel, error };
use mongodb::options::{ ClientOptions, ServerAddress, IndexOptions };

pub struct MongoDB;
impl MongoDB {
    fn init(&self) -> Result<Client, error::Error> {
        let app_name = env!("CARGO_PKG_NAME");
        let host = env::var("MONGO_HOST")
        .expect("MONGO_HOST must be set on .env file");
        let port = env::var("MONGO_PORT")
        .expect("MONGO_PORT must be set on .env file");

        let address = ServerAddress::Tcp {
            host,
            port: Some(port.parse().unwrap()),
        };

    let options = ClientOptions::builder()
        .hosts(vec![address])
        .direct_connection(Some(true))
        .max_idle_time(Some(Duration::new(30, 0)))
        .min_pool_size(Some(8))
        .max_pool_size(Some(256))
        .default_database(Some(app_name.into()))
        .app_name(Some(app_name.into()))
        .build();

        Ok(Client::with_options(options)?)
    }

    #[allow(dead_code)]
    pub fn connect(&self) -> Database {
        let client = self.init().expect("Failed to initiate MongoDB Client");
        client.default_database().expect("Failed to connect with Default Database")
    }

    #[allow(dead_code)]
    pub async fn connect_acid(&self) -> (Database, ClientSession) {
        let client = self.init().expect("Failed to initiate MongoDB Client");
        let db = client.default_database().expect("Failed to connect with Default Database");
        let session = client.start_session().await.expect("Failed to start MongoDB ClientSession");
        
        (db, session)
    }

    #[allow(dead_code)]
    pub fn connect_with(&self, db_name: &str) -> Database {
        let client = self.init().expect("Failed to initiate MongoDB Client");
        client.database(db_name)
    }

    // Ensure the indexes the app's query patterns rely on. Idempotent: MongoDB is a
    // no-op when an index with the same spec already exists, so this is safe to run
    // on every startup. Best-effort — a failure is logged but never aborts boot; the
    // app still serves requests, just without that index's speed-up / constraint.
    pub async fn ensure_indexes(&self) {
        let db = self.connect();
        let unique = || IndexOptions::builder().unique(true).build();
        
        let specs: Vec<(&str, IndexModel)> = vec![
            // project_user_state — one personal-state row per (user, project). Unique so
            // the pin upsert can't race two members into duplicate rows; the same
            // compound also serves the dashboard's per-user pinned lookup.
            ("project_user_state", IndexModel::builder()
            .keys(doc! { "user_id": 1, "project_id": 1 })
            .options(unique())
            .build()),
            // project_core — uuid is the identity used by every access/get/update/save.
            ("project_core", IndexModel::builder()
            .keys(doc! { "uuid": 1 })
            .options(unique())
            .build()),
            // project_core — dashboard "projects I own" query.
            ("project_core", IndexModel::builder()
            .keys(doc! { "owner_id": 1, "archived_at": 1 })
            .build()),
            // project_collaborator — dashboard "shared with me" query.
            ("project_collaborator", IndexModel::builder()
            .keys(doc! { "user_id": 1, "status": 1 })
            .build()),
            // project_collaborator — per-project collaborator listing.
            ("project_collaborator", IndexModel::builder()
            .keys(doc! { "project_id": 1 })
            .build()),
            // feedback — a user's history (newest first) and their daily-cap count
            // both key off (user_id, created_at).
            ("feedback", IndexModel::builder()
            .keys(doc! { "user_id": 1, "created_at": -1 })
            .build()),
            // project_comment — listing a project's threads (ordered by created_at).
            ("project_comment", IndexModel::builder()
            .keys(doc! { "project_id": 1, "created_at": 1 })
            .build()),
        ];

        for (collection, model) in specs {
            if let Err(error) = db
                .collection::<Document>(collection)
                .create_index(model)
                .await
            {
                log::error!("Failed to ensure index on {collection}: {error}");
            }
        }
  }
}
