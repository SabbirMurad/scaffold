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
        .route(
            "/{id}/public-link",
            web::post().to(Handler::Project::PublicLink::task)  // owner: turn the public view link on / off
        )
        .route(
            "/{id}/pin",
            web::post().to(Handler::Project::Pin::task)        // per-user pin / unpin
        )
        // Design image upload — raw image bytes as the body. A higher payload limit
        // than the default is allowed here since images are larger than JSON bodies.
        .service(
            web::resource("/{id}/image")
                .app_data(web::PayloadConfig::new(15 * 1024 * 1024))
                .route(web::post().to(Handler::Project::ImageUpload::task))
        )
        // Access requests (from someone who can't open the project yet)
        .route(
            "/{id}/request-access",
            web::post().to(Handler::Project::RequestAccess::task)
        )
        // Comments (Figma-style threads pinned to the canvas)
        .route(
            "/{id}/comments",
            web::get().to(Handler::Project::CommentsList::task)
        )
        .route(
            "/{id}/comments",
            web::post().to(Handler::Project::CommentCreate::task)   // start a thread
        )
        .route(
            "/{id}/comments/{comment_id}",
            web::patch().to(Handler::Project::CommentUpdate::task)  // resolve / reopen
        )
        .route(
            "/{id}/comments/{comment_id}",
            web::delete().to(Handler::Project::CommentDelete::task) // owner only
        )
        .route(
            "/{id}/comments/{comment_id}/messages",
            web::post().to(Handler::Project::CommentReply::task)    // append a reply
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
