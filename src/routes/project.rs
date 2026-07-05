use actix_web::web;
use crate::Handler;

pub fn router(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/api/v1/project")
        // Projects
        .route(
            "",
            web::post().to(Handler::Project::Create::task)
        )
        .route(
            "",
            web::get().to(Handler::Project::List::task)
        )
        .route(
            "/{id}",
            web::get().to(Handler::Project::Get::task)
        )
        .route(
            "/{id}",
            web::put().to(Handler::Project::Save::task)        // save design document
        )
        .route(
            "/{id}",
            web::patch().to(Handler::Project::Update::task)    // update metadata
        )
        .route(
            "/{id}",
            web::delete().to(Handler::Project::Delete::task)   // archive (soft-delete)
        )
        // Access requests (from someone who can't open the project yet)
        .route(
            "/{id}/request-access",
            web::post().to(Handler::Project::RequestAccess::task)
        )
        // Collaborators
        .route(
            "/{id}/collaborators",
            web::get().to(Handler::Project::Collaborators::task)
        )
        .route(
            "/{id}/collaborators",
            web::post().to(Handler::Project::Invite::task)
        )
        .route(
            "/{id}/collaborators/{invite_id}",
            web::patch().to(Handler::Project::Respond::task)   // invitee: accept / decline
        )
        .route(
            "/{id}/collaborators/{invite_id}",
            web::put().to(Handler::Project::SetRole::task)      // owner: change role
        )
        .route(
            "/{id}/collaborators/{invite_id}",
            web::delete().to(Handler::Project::RemoveCollaborator::task)
        )
    );

    // Incoming invites for the current user live outside the /project/{id} scope
    // (the invitee has no project access yet), so they get their own path.
    cfg.service(
        web::scope("/api/v1/invites")
        .route(
            "",
            web::get().to(Handler::Project::MyInvites::task)
        )
    );
}
