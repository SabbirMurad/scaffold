# Scaffold on winget

`winget install SabbirHassan.Scaffold` works once Scaffold is listed in Microsoft's
public winget catalog, the [microsoft/winget-pkgs](https://github.com/microsoft/winget-pkgs)
repository. Each version is listed by submitting its manifest there, and
Microsoft reviews it before it goes live (usually a few days).

`desktop/release.mjs` writes the manifest for each release on Windows:

```
winget/manifests/s/SabbirHassan/Scaffold/<version>/
  SabbirHassan.Scaffold.yaml               version file
  SabbirHassan.Scaffold.installer.yaml     installer URL + SHA-256
  SabbirHassan.Scaffold.locale.en-US.yaml  name, description, release notes
```

It points at the **versioned** installer, `downloads/Scaffold_<version>_x64-setup.exe`.
winget checks that file's SHA-256, so it must be uploaded to the server as-is and
never replaced.

## Submitting a version

1. Upload the release's files from `downloads/` to the server, including the
   versioned `Scaffold_<version>_x64-setup.exe`, and check that its URL downloads.
2. Check the manifest locally (optional):
   ```
   winget validate --manifest winget/manifests/s/SabbirHassan/Scaffold/<version>
   winget install --manifest winget/manifests/s/SabbirHassan/Scaffold/<version>
   ```
   (Installing from a local manifest needs `winget settings --enable LocalManifestFiles`,
   run as administrator, once.)
3. Submit it with Microsoft's tool, which forks winget-pkgs and opens the pull
   request for you (it asks for a GitHub token):
   ```
   winget install Microsoft.WingetCreate
   wingetcreate submit winget/manifests/s/SabbirHassan/Scaffold/<version>
   ```
4. Microsoft's checks run on the pull request (validation, and a malware scan of
   the installer), then a reviewer merges it. After that, `winget install
   SabbirHassan.Scaffold` installs that version, and `winget upgrade` picks up
   later ones once they're submitted too.
