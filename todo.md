# To do

## Google / GitHub sign-in

Set up and working (Firebase project `scaffold-c724e`; both providers tested in the app).

- [ ] **Before shipping:** copy the four `FIREBASE_*` values from `.env` into `.env.release`.
- [ ] **Release domain:** check that `sabbirhassan.com` is in Firebase → Authentication → Settings → Authorized domains.

## Decisions pending

- [ ] **Export fonts.** Generated text styles name their fonts (e.g. `fontFamily: 'Oswald'`) but the export doesn't include the font files, so they fall back to Roboto. Option: have the export download the TTFs the design uses into `assets/fonts/` and add a `fonts:` block to paste into `pubspec.yaml`, as in the velora template.
- [ ] **Provider tab URL preview.** It shows `base/v1/route`, but the generated code calls `base/api/v1/route` (CustomHttp adds `/api/v{n}`). Should the preview show the `/api` part?
- [ ] **2FA for social sign-in.** Google / GitHub sign-in skips the email 2FA code that password sign-in uses. Require it there too?
- [ ] **Export check in the repo.** Move the Flutter export-check scripts (export → host project → `flutter analyze` → screenshots) into the repo, e.g. `tools/export-check/`, so they can be rerun after codegen changes?
- [ ] **Mock Data tab.** Set names aren't validated (spaces, duplicates, Dart keywords go straight into the generated code), and the tab hasn't had a bug sweep yet.
- [ ] **Serving `/assets/`.** Everything in `assets/` is public. That's fine for the app's code (no secrets in it; public view links need the editor JS), but:
  - anything dropped into the folder by mistake is served too; consider serving only allowed file types;
  - production caches `/assets/` for 24h with unversioned URLs, so public links can run stale or mixed JS after a deploy; consider versioned URLs or a shorter cache.
