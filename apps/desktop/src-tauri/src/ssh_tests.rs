use super::ssh_args;

#[test]
fn ssh_uses_noninteractive_stdio_with_verified_host_keys() {
    let args = ssh_args("dev-box", "/srv/project").unwrap();
    for required in ["-T", "BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ClearAllForwardings=yes"] {
        assert!(args.iter().any(|arg| arg == required), "missing {required}");
    }
    assert_eq!(&args[args.len() - 3..], ["--", "dev-box", "cd '/srv/project' && exec keryx acp --profile shell"]);
}

#[test]
fn quotes_the_remote_path_as_one_shell_word() {
    let args = ssh_args("dev", "/srv/it's a $project").unwrap();
    assert_eq!(args.last().unwrap(), "cd '/srv/it'\\''s a $project' && exec keryx acp --profile shell");
}

#[test]
fn rejects_non_aliases_and_invalid_paths() {
    for alias in ["", "-dev", "user@host", "host name", "ssh://dev"] {
        assert!(ssh_args(alias, "/srv/project").unwrap_err().contains("alias"));
    }
    for path in ["", "relative", "~/project", "/bad\npath", "/bad\0path"] {
        assert!(ssh_args("dev", path).unwrap_err().contains("path"));
    }
}
