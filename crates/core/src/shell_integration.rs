//! Per-session startup files and input widgets. Integration is loaded through
//! shell startup arguments, never typed into an interactive command line.

pub struct RemoteShell {
    pub command: String,
    pub files: Vec<(String, String)>,
}

fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn fish_quote(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

pub fn remote(shell: &str, marker: &str, directory: &str) -> Option<RemoteShell> {
    let kind = shell.rsplit('/').next()?;
    let integration = match kind {
        "bash" => include_str!("shell/bash.sh"),
        "zsh" => include_str!("shell/zsh.sh"),
        "fish" => include_str!("shell/fish.fish"),
        _ => return None,
    };
    Some(remote_with_script(shell, marker, directory, integration))
}

fn remote_with_script(
    shell: &str,
    marker: &str,
    directory: &str,
    integration: &str,
) -> RemoteShell {
    let kind = shell.rsplit('/').next().unwrap_or(shell);
    // include_str! preserves Windows checkout line endings. Shell startup
    // files are Unix input regardless of the platform that builds the app.
    let integration = integration
        .replace("\r\n", "\n")
        .replace("__SC_MARKER__", marker);
    let mut files = Vec::new();
    let command = match kind {
        "bash" => {
            // Match the usual login profile order while using a private rcfile
            // to load the integration before Bash starts reading commands.
            let startup = format!(
                "if [ -r /etc/profile ]; then . /etc/profile; fi\nfor __sc_profile in \"$HOME/.bash_profile\" \"$HOME/.bash_login\" \"$HOME/.profile\"; do\n    if [ -r \"$__sc_profile\" ]; then . \"$__sc_profile\"; break; fi\ndone\nunset __sc_profile\n{integration}"
            );
            files.push(("init".into(), startup));
            format!(
                "exec {} --rcfile {} -i",
                quote(shell),
                quote(&format!("{directory}/init"))
            )
        }
        "zsh" => {
            for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin"] {
                let mut startup = format!(
                    "if [[ $SC_USER_ZDOTDIR_SET == 1 ]]; then ZDOTDIR=$SC_USER_ZDOTDIR; else unset ZDOTDIR; fi\nif [[ -r ${{ZDOTDIR-$HOME}}/{name} ]]; then source \"${{ZDOTDIR-$HOME}}/{name}\"; fi\nSC_USER_ZDOTDIR_SET=${{+ZDOTDIR}}\nSC_USER_ZDOTDIR=${{ZDOTDIR-}}\n"
                );
                if name == ".zlogin" {
                    startup.push_str("unset SC_USER_ZDOTDIR SC_USER_ZDOTDIR_SET\n");
                    startup.push_str(&integration);
                } else {
                    startup.push_str(&format!("ZDOTDIR={}\n", quote(directory)));
                }
                files.push((name.into(), startup));
            }
            format!(
                "exec env SC_USER_ZDOTDIR_SET=\"${{+ZDOTDIR}}\" SC_USER_ZDOTDIR=\"${{ZDOTDIR-}}\" ZDOTDIR={} {} -il",
                quote(directory), quote(shell),
            )
        }
        "fish" => {
            files.push(("init".into(), integration));
            format!(
                "exec {} --login --interactive --init-command {}",
                fish_quote(shell),
                fish_quote(&format!(
                    "source {}",
                    fish_quote(&format!("{directory}/init"))
                ))
            )
        }
        _ => unreachable!(),
    };
    // Delete only our known files, without recursively removing the directory.
    // Functions are already in memory when the first prompt is displayed.
    let path_quote = if kind == "fish" { fish_quote } else { quote };
    let paths = files
        .iter()
        .map(|(name, _)| path_quote(&format!("{directory}/{name}")))
        .collect::<Vec<_>>()
        .join(" ");
    let cleanup = format!(
        "\ncommand rm -f -- {paths}\ncommand rmdir -- {} 2>/dev/null\n",
        path_quote(directory)
    );
    files.last_mut().unwrap().1.push_str(&cleanup);
    RemoteShell { command, files }
}

pub fn powershell(marker: &str) -> String {
    include_str!("shell/powershell.ps1").replace("__SC_MARKER__", marker)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_templates_produce_unix_startup_files() {
        for (shell, template) in [
            ("bash", include_str!("shell/bash.sh")),
            ("zsh", include_str!("shell/zsh.sh")),
            ("fish", include_str!("shell/fish.fish")),
        ] {
            let windows_template = template.replace("\r\n", "\n").replace('\n', "\r\n");
            let plan = remote_with_script(
                shell,
                "1234567890abcdef1234567890abcdef",
                "/tmp/sc-init",
                &windows_template,
            );
            for (name, contents) in plan.files {
                assert!(
                    !contents.contains('\r'),
                    "{shell}/{name} contains Windows line endings"
                );
                assert!(contents.ends_with('\n'));
            }
        }
    }
}
