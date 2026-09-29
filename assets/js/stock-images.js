// Loading Openverse stock photos reliably — shared by the image picker and
// Claude's "search" images (claude-tools.js).
//
// Openverse's thumbnail (`thumbnail`, a resizing proxy at api.openverse.org)
// often fails with 424 for Flickr photos even though the photo itself loads
// fine from Flickr — about half of a typical page. So every result carries
// fallbacks: the original at a smaller size (Flickr encodes the size in the
// file name: _n is 320px, _z 640px), then the original as-is.

// A Flickr photo URL at another size; other URLs are returned unchanged.
// https://live.staticflickr.com/7641/16974972212_7732bc0090_b.jpg → …_z.jpg
export function sized(url, suffix) {
  const m = /^(https:\/\/[^/]*staticflickr\.com\/.*\/\d+_[0-9a-f]+)(_[a-z0-9]{1,2})?\.(jpg|jpeg|png|gif)$/i.exec(url || '');
  return m ? `${m[1]}${suffix}.${m[3]}` : url;
}

// URLs to try for a result, best first, without repeats. `preview`: small
// enough for a grid tile; otherwise sized for placing on the canvas.
export function candidates(hit, preview = false) {
  const list = [hit.thumbnail, sized(hit.url, preview ? '_n' : '_z'), hit.url];
  return [...new Set(list.filter(Boolean))];
}

// Fetch an image and return it as a data URI. Throws unless the answer really
// is an image (a failed proxy answers with an error body, not a picture).
export async function fetchImageDataUri(url) {
  const res = await fetch(url);
  const blob = res.ok ? await res.blob() : null;
  if (!blob || !blob.type.startsWith('image/')) throw new Error(`Image failed to load (${res.status})`);
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('Image failed to load'));
    r.readAsDataURL(blob);
  });
}

// The first of `urls` that loads, as a data URI (null if none does).
export async function firstImageDataUri(urls) {
  for (const url of urls) {
    try { return await fetchImageDataUri(url); } catch { /* try the next */ }
  }
  return null;
}
