/// OpenSSH passes the command to the remote user's shell, so quote the path.
pub fn ssh_args(alias: &str, cwd: &str) -> Result<Vec<String>, String> {
    if alias.is_empty() || alias.starts_with('-')
        || !alias.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
    {
        return Err("Enter an SSH host alias (letters, digits, dots, underscores or hyphens).".into());
    }
    if !cwd.starts_with('/') || cwd.chars().any(char::is_control) {
        return Err("Enter an absolute remote project path, such as /home/me/project.".into());
    }

    let path = cwd.replace('\'', "'\\''");
    let command = format!("cd '{path}' && exec keryx acp --profile shell");
    let mut args = vec!["-T".into()];
    for option in ["BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no",
        "ForwardX11=no", "ClearAllForwardings=yes", "ControlPath=none", "PermitLocalCommand=no",
        "ConnectTimeout=10", "ServerAliveInterval=15", "ServerAliveCountMax=3"]
    {
        args.extend(["-o".into(), option.into()]);
    }
    args.extend(["--".into(), alias.into(), command]);
    Ok(args)
}

#[cfg(test)]
#[path = "ssh_tests.rs"]
mod tests;
