use actix_files::NamedFile;
use actix_web::http::header::{
    ContentDisposition, ContentEncoding, DispositionParam, DispositionType,
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_ENCODING, CONTENT_TYPE, ETAG, IF_RANGE, LAST_MODIFIED, RANGE,
};
use actix_web::{web, Error, HttpRequest, HttpResponse, Responder};
use std::path::PathBuf;

// Where the desktop installers live (uploaded to the server by hand).
const DIR: &str = "downloads";
// What may be downloaded: the installers, nothing else in the folder.
const ALLOWED: [&str; 6] = ["msi", "exe", "dmg", "appimage", "deb", "zip"];

// GET/HEAD /downloads/{file} — a desktop installer, sent in parts.
//
// The file streams from disk in chunks and honours Range requests (206 Partial
// Content with Content-Range), so a download that drops can resume from where
// it stopped instead of starting over. It goes out as-is — never compressed:
// with a Content-Length the browser shows real progress, and byte ranges match
// what it's receiving (an on-the-fly compressed stream had neither, and
// installers barely compress anyway).
pub async fn task(req: HttpRequest, path: web::Path<String>) -> Result<HttpResponse, Error> {
    let name = path.into_inner();

    // A plain file name with an installer extension — no paths, no dotfiles.
    let plain = !name.is_empty()
        && !name.starts_with('.')
        && name.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    let ext_ok = name
        .rsplit_once('.')
        .map(|(_, ext)| ALLOWED.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    if !plain || !ext_ok {
        return Ok(HttpResponse::NotFound().body("Not found"));
    }

    let file_path: PathBuf = [DIR, name.as_str()].iter().collect();
    if !file_path.is_file() {
        return Ok(HttpResponse::NotFound().body("Not found"));
    }

    let file = match NamedFile::open_async(&file_path).await {
        Ok(file) => file,
        Err(error) => {
            log::error!("download {}: {:?}", name, error);
            return Ok(HttpResponse::NotFound().body("Not found"));
        }
    };

    let mut res = file
        .use_etag(true)
        .use_last_modified(true)
        .set_content_type(actix_web::mime::APPLICATION_OCTET_STREAM)
        .set_content_encoding(ContentEncoding::Identity)
        .set_content_disposition(disposition(&name))
        .respond_to(&req)
        .map_into_boxed_body();

    // A resume names the version it started with (If-Range). If the installer has
    // been replaced since, the range must not be honoured — the old start plus the
    // new end would be a broken file — so the whole current file goes out instead.
    // actix-files serves the range regardless, so it's checked here, against the
    // ETag / Last-Modified of the file as it is now.
    let header = |r: &HttpResponse, k| r.headers().get(k).and_then(|v| v.to_str().ok()).map(str::to_string);
    let (etag, modified) = (header(&res, ETAG), header(&res, LAST_MODIFIED));
    let if_range = req.headers().get(IF_RANGE).and_then(|v| v.to_str().ok()).map(|v| v.trim().to_string());
    if let (true, Some(wanted)) = (req.headers().contains_key(RANGE), if_range) {
        if Some(&wanted) != etag.as_ref() && Some(&wanted) != modified.as_ref() {
            let bytes = web::block(move || std::fs::read(&file_path)).await??;
            let mut full = HttpResponse::Ok();
            full.insert_header((CONTENT_TYPE, "application/octet-stream"))
                .insert_header((CONTENT_ENCODING, "identity"))
                .insert_header((ACCEPT_RANGES, "bytes"))
                .insert_header(disposition(&name));
            if let Some(tag) = etag { full.insert_header((ETAG, tag)); }
            if let Some(date) = modified { full.insert_header((LAST_MODIFIED, date)); }
            res = full.body(bytes);
        }
    }

    // Installers are replaced in place on a new release: always revalidate.
    res.headers_mut().insert(CACHE_CONTROL, "no-cache".parse().unwrap());
    Ok(res)
}

fn disposition(name: &str) -> ContentDisposition {
    ContentDisposition {
        disposition: DispositionType::Attachment,
        parameters: vec![DispositionParam::Filename(name.to_string())],
    }
}
