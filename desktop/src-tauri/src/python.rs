//! Python for the design skill. ui-ux-pro-max's search scripts are Python 3
//! (standard library only), and Claude runs them through its shell as
//! `python`, `python3` or `py -3`. When none of those works, Scaffold installs
//! Python — without admin rights, for this user — before the turn starts.

use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use crate::agent::no_window;

/// What Claude Code needs to run Python: nothing when it's already on PATH, or
/// a folder to put at the front of PATH (installed, but after this app started
/// or where PATH doesn't reach).
pub type Found = Option<PathBuf>;

/// Find Python 3, installing it if there is none. `say` tells the panel.
pub fn ensure(say: impl Fn(&str)) -> Result<Found, String> {
    if let Some(found) = find() {
        return Ok(found);
    }
    say("Installing Python for the design skill…");
    // Whether it worked is decided by looking again, not by the installer's exit
    // code: winget also fails when Python is already there ("No available upgrade").
    let installed = install();
    find().ok_or_else(|| {
        installed.err().unwrap_or_else(|| {
            failed("It was installed, but Scaffold can't find it. Restarting Scaffold usually fixes this.")
        })
    })
}

/// PATH for Claude Code with `dir` in front (and its Scripts folder, on Windows).
pub fn path_with(dir: &Path) -> std::ffi::OsString {
    let mut dirs = vec![dir.to_path_buf()];
    if cfg!(windows) {
        dirs.push(dir.join("Scripts"));
    }
    dirs.extend(std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
    std::env::join_paths(dirs).unwrap_or_default()
}

fn find() -> Option<Found> {
    // On PATH already. The Windows Store's `python` stand-ins exist on PATH but
    // don't run Python, so each is asked for its version rather than looked for.
    for (exe, args) in [("python", &["--version"][..]), ("python3", &["--version"]), ("py", &["-3", "--version"])] {
        if is_python3(Path::new(exe), args) {
            return Some(None);
        }
    }
    // Installed where PATH doesn't reach (yet).
    known_installs().into_iter().find(|exe| is_python3(exe, &["--version"])).map(|exe| exe.parent().map(Path::to_path_buf))
}

fn is_python3(exe: &Path, args: &[&str]) -> bool {
    let mut cmd = Command::new(exe);
    cmd.args(args).stdin(Stdio::null());
    no_window(&mut cmd);
    match cmd.output() {
        // Python 3.3 and earlier print the version on stderr.
        Ok(out) if out.status.success() => [&out.stdout, &out.stderr]
            .iter()
            .any(|b| String::from_utf8_lossy(b).trim_start().starts_with("Python 3")),
        _ => false,
    }
}

/// Where Python is installed when it isn't on PATH, newest first.
fn known_installs() -> Vec<PathBuf> {
    let mut found = Vec::new();
    if cfg!(windows) {
        // The python.org installer (and winget's), per user and for everyone.
        let roots = [
            std::env::var_os("LOCALAPPDATA").map(|d| PathBuf::from(d).join("Programs").join("Python")),
            std::env::var_os("ProgramFiles").map(PathBuf::from),
        ];
        for root in roots.into_iter().flatten() {
            let Ok(entries) = std::fs::read_dir(&root) else { continue };
            let mut dirs: Vec<PathBuf> = entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("Python3")))
                .collect();
            dirs.sort_by_key(|p| std::cmp::Reverse(version_of(p)));
            found.extend(dirs.into_iter().map(|d| d.join("python.exe")));
        }
    } else {
        // Homebrew (Apple silicon, then Intel) and the python.org macOS installer.
        found.push(PathBuf::from("/opt/homebrew/bin/python3"));
        found.push(PathBuf::from("/usr/local/bin/python3"));
        found.push(PathBuf::from("/Library/Frameworks/Python.framework/Versions/Current/bin/python3"));
    }
    found.into_iter().filter(|p| p.is_file()).collect()
}

/// "Python313" → 313, for picking the newest install folder.
fn version_of(dir: &Path) -> u32 {
    dir.file_name()
        .and_then(|n| n.to_str())
        .and_then(|n| n.trim_start_matches("Python").parse().ok())
        .unwrap_or(0)
}

/// The version installed when there is none.
#[cfg(windows)]
const WINGET_ID: &str = "Python.Python.3.13";

#[cfg(windows)]
fn install() -> Result<(), String> {
    // winget ships with Windows 10 (1809+) and 11. A per-user install needs no
    // admin prompt; the agreements flags keep it from asking anything.
    run(
        "winget",
        &[
            "install", "--id", WINGET_ID, "--exact", "--source", "winget", "--scope", "user", "--silent",
            "--accept-package-agreements", "--accept-source-agreements", "--disable-interactivity",
        ],
    )
    .map_err(|e| failed(&e))
}

#[cfg(target_os = "macos")]
fn install() -> Result<(), String> {
    // Only through Homebrew, which installs without a password. Without it,
    // Python needs the person (an installer that asks for their password).
    let brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].into_iter().find(|p| Path::new(p).is_file());
    let Some(brew) = brew else {
        return Err(failed("Scaffold installs it with Homebrew, and Homebrew isn't installed."));
    };
    run(brew, &["install", "python@3.13"]).map_err(|e| failed(&e))
}

#[cfg(not(any(windows, target_os = "macos")))]
fn install() -> Result<(), String> {
    // Linux package managers need root, which Scaffold can't ask for here.
    Err(failed("On Linux, install it with your package manager (e.g. `sudo apt install python3`)."))
}

#[allow(dead_code)]
fn run(program: &str, args: &[&str]) -> Result<(), String> {
    let mut cmd = Command::new(program);
    cmd.args(args).stdin(Stdio::null());
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("`{program}` could not be started: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let said = [&out.stdout[..], &out.stderr[..]]
        .iter()
        .map(|b| String::from_utf8_lossy(b).trim().to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    // winget prints progress bars; the last lines say what went wrong.
    let tail: Vec<&str> = said.lines().rev().take(6).collect();
    let tail: Vec<&str> = tail.into_iter().rev().collect();
    Err(format!("`{program} {}` failed ({}):\n{}", args.first().unwrap_or(&""), out.status, tail.join("\n")))
}

fn failed(detail: &str) -> String {
    format!(
        "The design skill needs Python 3, and Scaffold couldn't install it.\n\n{detail}\n\n\
         Install Python 3 from https://www.python.org/downloads/ and send your message again."
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn newest_install_folder_first() {
        assert!(version_of(Path::new("Python313")) > version_of(Path::new("Python39")));
        assert_eq!(version_of(Path::new("Launcher")), 0);
    }

    #[test]
    fn claude_code_gets_the_folder_first_on_its_path() {
        let dir = PathBuf::from(if cfg!(windows) { r"C:\py" } else { "/py" });
        let path = path_with(&dir);
        let first = std::env::split_paths(&path).next().unwrap();
        assert_eq!(first, dir);
    }
}
