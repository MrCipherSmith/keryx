//! Semver comparison against the minimum keryx the app declares.

use std::cmp::Ordering;

/// The protocol floor: the oldest keryx whose `keryx acp` this client can
/// talk to at all. It does not imply the `shell` profile: released keryx
/// 0.4.32 to 0.4.35 have no shell profile, so the client checks what
/// `initialize` reports for that, not this version.
pub const MIN_KERYX_VERSION: &str = "0.4.44";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Version {
    pub major: u64,
    pub minor: u64,
    pub patch: u64,
    pub pre: Vec<String>,
}

/// Lenient parse: optional leading `v`, 1 to 3 numeric components, optional
/// `-pre` and `+build`. `"0"` parses as 0.0.0 (keryx used to report that).
pub fn parse(input: &str) -> Option<Version> {
    let s = input.trim().trim_start_matches('v');
    let s = s.split('+').next()?;
    let (core, pre) = match s.split_once('-') {
        Some((c, p)) => (c, p.split('.').map(str::to_string).collect()),
        None => (s, Vec::new()),
    };
    let mut nums = [0u64; 3];
    let mut count = 0;
    for part in core.split('.') {
        if count == 3 {
            return None;
        }
        nums[count] = part.parse().ok()?;
        count += 1;
    }
    if count == 0 {
        return None;
    }
    Some(Version { major: nums[0], minor: nums[1], patch: nums[2], pre })
}

fn cmp_pre(a: &[String], b: &[String]) -> Ordering {
    match (a.is_empty(), b.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        _ => {}
    }
    for (x, y) in a.iter().zip(b.iter()) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(n), Ok(m)) => n.cmp(&m),
            (Ok(_), Err(_)) => Ordering::Less,
            (Err(_), Ok(_)) => Ordering::Greater,
            (Err(_), Err(_)) => x.cmp(y),
        };
        if ord != Ordering::Equal {
            return ord;
        }
    }
    a.len().cmp(&b.len())
}

pub fn compare(a: &Version, b: &Version) -> Ordering {
    (a.major, a.minor, a.patch)
        .cmp(&(b.major, b.minor, b.patch))
        .then_with(|| cmp_pre(&a.pre, &b.pre))
}

/// `true` when `found` parses and is at least `minimum`.
pub fn meets_minimum(found: &str, minimum: &str) -> bool {
    match (parse(found), parse(minimum)) {
        (Some(f), Some(m)) => compare(&f, &m) != Ordering::Less,
        _ => false,
    }
}

pub fn is_compatible(found: &str) -> bool {
    meets_minimum(found, MIN_KERYX_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_full_partial_and_prefixed_versions() {
        assert_eq!(parse("0.4.32").unwrap(), Version { major: 0, minor: 4, patch: 32, pre: vec![] });
        assert_eq!(parse("v1.2").unwrap().patch, 0);
        assert_eq!(parse("0").unwrap().major, 0);
        assert_eq!(parse("1.2.3+build.5").unwrap().patch, 3);
        assert_eq!(parse("1.2.3-rc.1").unwrap().pre, vec!["rc", "1"]);
    }

    #[test]
    fn rejects_garbage() {
        assert!(parse("").is_none());
        assert!(parse("abc").is_none());
        assert!(parse("1.2.3.4").is_none());
        assert!(parse("1..2").is_none());
    }

    #[test]
    fn compares_numerically_not_lexically() {
        assert!(meets_minimum("0.4.100", "0.4.32"));
        assert!(!meets_minimum("0.4.9", "0.4.32"));
        assert!(meets_minimum("0.10.0", "0.4.32"));
        assert!(meets_minimum("1.0.0", "0.4.32"));
    }

    #[test]
    fn equal_version_is_compatible() {
        assert!(is_compatible(MIN_KERYX_VERSION));
    }

    #[test]
    fn prerelease_sorts_below_its_release() {
        assert!(!meets_minimum("0.4.32-rc.1", "0.4.32"));
        assert!(meets_minimum("0.4.33-rc.1", "0.4.32"));
        let a = parse("1.0.0-alpha.2").unwrap();
        let b = parse("1.0.0-alpha.10").unwrap();
        assert_eq!(compare(&a, &b), Ordering::Less);
    }

    #[test]
    fn legacy_zero_and_unparseable_are_incompatible() {
        assert!(!is_compatible("0"));
        assert!(!is_compatible("unknown"));
    }
}
