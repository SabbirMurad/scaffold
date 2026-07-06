use futures::TryStreamExt;
use mongodb::bson::doc;
use crate::BuiltIns::mongo::MongoDB;
use crate::utils::response::Response;
use crate::Model::Project::ProjectComment;
use actix_web::{ web, Error, HttpResponse, HttpRequest };
use crate::Middleware::Auth::{ require_access, AccessRequirement };

// Every comment thread on a project, oldest first. Any member with access may read.
pub async fn task(req: HttpRequest, path: web::Path<String>) -> Result<HttpResponse, Error> {
    let user = require_access(&req, AccessRequirement::AnyToken)?;
    let project_id = path.into_inner();
    let db = MongoDB.connect();

    if let Err(response) = super::access(&db, &project_id, &user.user_id).await {
        return Ok(response);
    }

    let comments = match db
        .collection::<ProjectComment>("project_comment")
        .find(doc! { "project_id": &project_id })
        .sort(doc! { "created_at": 1 })
        .await
    {
        Ok(cursor) => match cursor.try_collect::<Vec<ProjectComment>>().await {
            Ok(list) => list,
            Err(error) => {
                log::error!("{:?}", error);
                return Ok(Response::internal_server_error(&error.to_string()));
            }
        },
        Err(error) => {
            log::error!("{:?}", error);
            return Ok(Response::internal_server_error(&error.to_string()));
        }
    };

    Ok(HttpResponse::Ok().content_type("application/json").json(comments))
}
