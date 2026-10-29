//! Per-session shell widgets; automatic directory changes never execute an
//! input line, so they cannot enter the shell's command history.

pub fn remote(shell: &str, marker: &str) -> Option<String> {
    let script = match shell {
        "bash" => include_str!("shell/bash.sh"),
        "zsh" => include_str!("shell/zsh.sh"),
        "fish" => include_str!("shell/fish.fish"),
        _ => return None,
    }
    .replace("__SC_MARKER__", marker);
    // A leading space excludes initialization from fish/zsh history. Bash
    // removes exactly its own initialization entry before any prompt hooks.
    Some(format!(
        " eval '{}' #SC_INIT_{marker}\r \r",
        script.replace('\'', "'\\''")
    ))
}

pub fn powershell(marker: &str) -> String {
    include_str!("shell/powershell.ps1").replace("__SC_MARKER__", marker)
}
