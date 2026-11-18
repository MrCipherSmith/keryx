//! What a flow package is: the one rule the board's listing, reading and
//! watching share, and that the mutation gate (`actions::validate_flow_dir`)
//! builds on.

/// Longest package name accepted (keryx's own names stay far below: three
/// digits, a date and a slug of at most 40 characters).
pub const MAX_DIR_LEN: usize = 200;

/// True when `name` is a flow package name as keryx's own `listFlowDirs` sees
/// it: it starts with `^\d{3}-`. Beyond that it must be one path component
/// with no NUL, `/` or control character. keryx resolves every name it lists
/// by exact match, whatever other characters it holds.
pub fn is_flow_dir_name(name: &str) -> bool {
    let b = name.as_bytes();
    b.len() >= 4
        && b.len() <= MAX_DIR_LEN
        && b[..3].iter().all(u8::is_ascii_digit)
        && b[3] == b'-'
        && !name.chars().any(|c| c == '/' || c.is_control())
}

/// The package name when it is safe to paste into a shell command as it is:
/// only `[A-Za-z0-9._+-]` after the `\d{3}-` prefix. `None` for any other name;
/// the board then offers no copyable command. Actions never use this: they
/// build argv from validated parts.
pub fn command_ref(name: &str) -> Option<String> {
    let shell_safe = |c: u8| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'+' | b'-');
    (is_flow_dir_name(name) && name.as_bytes()[4..].iter().all(|&c| shell_safe(c))).then(|| name.to_string())
}

/// The package name of `entry` when it is a flow package keryx would list: a
/// real directory (a symlink is not, as in keryx's `listFlowDirs`, which reads
/// the entry type without following links) with a package name.
pub fn package_name(entry: &std::fs::DirEntry) -> Option<String> {
    let name = entry.file_name().to_str()?.to_string();
    let is_real_dir = entry.file_type().is_ok_and(|t| t.is_dir());
    (is_real_dir && is_flow_dir_name(&name)).then_some(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keryx_listing_rule_with_one_safe_path_component() {
        for ok in ["001-x", "999-", "012-Write-Docs", "012-a.b", "012-a_b", "012-a b", "012-ünïcode"] {
            assert!(is_flow_dir_name(ok), "{ok:?}");
        }
        for bad in ["", "12-x", "012", "0123-x", "-12-x", "012-a/b", "012-a\0b", "012-a\nb", "012-\u{1b}[31m", "١٢٣-x"] {
            assert!(!is_flow_dir_name(bad), "{bad:?}");
        }
        assert!(!is_flow_dir_name(&format!("001-{}", "a".repeat(MAX_DIR_LEN))));
    }

    #[test]
    fn command_ref_only_for_shell_safe_names() {
        for safe in ["487-2026-11-10-shell-product-review-p1", "012-Write-Docs", "012-a.b", "012-a_b", "012-v1+2", "999-"] {
            assert_eq!(command_ref(safe).as_deref(), Some(safe), "{safe:?}");
        }
        for unsafe_name in ["012-a b", "012-a;rm", "012-$(x)", "012-a'b", "012-ünïcode", "012-a\"b", "012-a*", "not-a-flow"] {
            assert_eq!(command_ref(unsafe_name), None, "{unsafe_name:?}");
        }
    }
}
