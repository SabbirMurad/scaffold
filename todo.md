# To do

## Google / GitHub sign-in: Firebase setup

The code is done (desktop app, sign-in page, backend). It needs a Firebase project to run.

- [ ] **Create the Firebase project.** In the Firebase console: create a project, then Add app → Web.
- [ ] **Fill in the config.** Copy the web app's `apiKey`, `authDomain`, `projectId` and `appId` into the empty keys at the end of `.env`, `.env.dev` and `.env.release`, then restart the server:
  - `FIREBASE_WEB_API_KEY`
  - `FIREBASE_AUTH_DOMAIN`
  - `FIREBASE_PROJECT_ID`
  - `FIREBASE_APP_ID`
- [ ] **Turn on Google.** Authentication → Sign-in method → Google → Enable.
- [ ] **Turn on GitHub.**
  - On GitHub: Settings → Developer settings → OAuth Apps → New OAuth App.
  - Set the callback URL to `https://<your-project>.firebaseapp.com/__/auth/handler` (Firebase shows the exact URL when you enable GitHub).
  - Paste the app's Client ID and Client Secret into Authentication → Sign-in method → GitHub.
- [ ] **Authorize the release domain.** Authentication → Settings → Authorized domains: add `sabbirhassan.com` (`localhost` is already there for development).
- [ ] **Try both buttons** on the app's sign-in page.
  - A GitHub account whose email isn't verified on GitHub is refused. That's intended: it prevents account takeover.

## Decisions pending

- [ ] **Export fonts.** Generated text styles name their fonts (e.g. `fontFamily: 'Oswald'`) but the export doesn't include the font files, so they fall back to Roboto. Option: have the export download the TTFs the design uses into `assets/fonts/` and add a `fonts:` block to paste into `pubspec.yaml`, as in the velora template.
- [ ] **Provider tab URL preview.** It shows `base/v1/route`, but the generated code calls `base/api/v1/route` (CustomHttp adds `/api/v{n}`). Should the preview show the `/api` part?
- [ ] **2FA for social sign-in.** Google / GitHub sign-in skips the email 2FA code that password sign-in uses. Require it there too?
- [ ] **Export check in the repo.** Move the Flutter export-check scripts (export → host project → `flutter analyze` → screenshots) into the repo, e.g. `tools/export-check/`, so they can be rerun after codegen changes?
- [ ] **Mock Data tab.** Set names aren't validated (spaces, duplicates, Dart keywords go straight into the generated code), and the tab hasn't had a bug sweep yet.

## Not committed yet

- [ ] Export fixes: `headers:`, endpoints as just the route, theme-aware colours (`codegen.js`, `widgetgen.js`).
- [ ] Google / GitHub sign-in:
  - `desktop/src-tauri/src/oauth.rs`
  - `pages/social-auth.html`
  - `src/handler/auth/social_login.rs`
  - `src/markup.rs`
  - `src/routes/pages.rs`
  - `assets/js/auth.js`
  - `assets/css/auth.css`
