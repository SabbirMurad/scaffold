use mongodb::bson::doc;
use crate::Model::Account;
use actix_web::HttpResponse;
use mongodb::{ClientSession, Database};
use crate::utils::response::Response;

pub mod refresh;
pub use refresh as Refresh;

pub mod sign_up;
pub use sign_up as SignUp;

pub mod verify_email;
pub use verify_email as VerifyEmail;

pub mod resend_verification_code;
pub use resend_verification_code as ResendVerificationCode;

pub mod sign_in;
pub use sign_in as SignIn;

pub mod sign_out;
pub use sign_out as SignOut;

pub mod forgot_password;
pub use forgot_password as ForgotPassword;

pub mod verify_reset_code;
pub use verify_reset_code as VerifyResetCode;

pub mod reset_password;
pub use reset_password as ResetPassword;

pub mod change_password;
pub use change_password as ChangePassword;

pub mod get;
pub use get as Get;

pub mod me;
pub use me as Me;

pub mod social_login;
pub use social_login as SocialLogin;


pub async fn delete_account(
    db: &Database,
    session: &mut ClientSession,
    user_id: &str
) -> Result<(), HttpResponse> {
    let collection = db.collection::<Account::AccountCore>("account_core");
    let result = collection.delete_one(
        doc!{"uuid": user_id},
    ).await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        session.abort_transaction().await.ok().unwrap();
        return Err(Response::internal_server_error(&error.to_string()));
    }

    let collection = db.collection::
    <Account::AccountProfile>("account_profile");
    let result = collection.delete_one(
        doc!{"uuid": user_id},
    ).await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        session.abort_transaction().await.ok().unwrap();
        return Err(Response::internal_server_error(&error.to_string()));
    }

    let collection = db.collection::
    <Account::AccountVerificationRequest>("account_verification_request");
    let result = collection.delete_one(
        doc!{"uuid": user_id},
    ).await;

    if let Err(error) = result {
        log::error!("{:?}", error);
        session.abort_transaction().await.ok().unwrap();
        return Err(Response::internal_server_error(&error.to_string()));
    }

    Ok(())
}