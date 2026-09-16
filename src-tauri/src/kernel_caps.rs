//! Kernel capability probes.
//!
//! The desktop app drives kernels from several dsh releases and a few
//! behaviours are version-gated. Everything here is **best effort**: an
//! unreadable or unparsable manifest reports the *older* behaviour, so an
//! unknown (or explicitly overridden) kernel keeps working exactly as it did
//! before these probes existed.

use std::path::Path;

/// First dsh release that mints a browser-session launch token and accepts the
/// web app's `--no-open` flag. The two ship together: a kernel from this
/// release on both returns 401 for an untokenized GUI request and pops the
/// system browser unless told not to.
const BROWSER_AUTH_SINCE: &str = "0.1.2-rc.1";

/// A parsed `major.minor.patch[-label.number]` version.
#[derive(Debug)]
struct Version {
    major: u64,
    minor: u64,
    patch: u64,
    /// Pre-release part as (label, number); None for a plain release.
    pre: Option<(String, u64)>,
}

/// Parse the subset of SemVer these kernels use. Returns None on anything
/// unexpected, which callers treat as "unknown, assume old".
fn parse_version(raw: &str) -> Option<Version> {
    let raw = raw.trim();
    let (core, pre) = match raw.split_once('-') {
        Some((c, p)) => (c, Some(p)),
        None => (raw, None),
    };
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    let pre = pre.map(|p| match p.rsplit_once('.') {
        Some((label, number)) => (label.to_string(), number.parse().unwrap_or(0)),
        None => (p.to_string(), 0),
    });
    Some(Version { major, minor, patch, pre })
}

/// Rank pre-release labels so `rc` outranks `alpha`; unknown labels rank last.
fn pre_rank(label: &str) -> u8 {
    match label {
        "alpha" => 0,
        "beta" => 1,
        "rc" => 2,
        _ => 3,
    }
}

/// `actual >= threshold`, including SemVer's rule that a release outranks any
/// pre-release of the same core version.
fn version_at_least(actual: &Version, threshold: &Version) -> bool {
    let a = (actual.major, actual.minor, actual.patch);
    let b = (threshold.major, threshold.minor, threshold.patch);
    if a != b {
        return a > b;
    }
    match (&actual.pre, &threshold.pre) {
        (None, _) => true,
        (Some(_), None) => false,
        (Some(x), Some(y)) => (pre_rank(&x.0), x.1) >= (pre_rank(&y.0), y.1),
    }
}

/// Version of the `@deepseek-ai/dsh` package owning this `bin.js`
/// (`<pkg>/lib/bin.js` → `<pkg>/package.json`).
pub fn dsh_package_version(bin_js: &Path) -> Option<String> {
    let manifest = bin_js.parent()?.parent()?.join("package.json");
    let text = std::fs::read_to_string(manifest).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version")?.as_str().map(str::to_string)
}

/// Whether this kernel speaks the browser-session handshake (and therefore
/// understands `--no-open`). Unknown paths report `false` — the pre-token
/// behaviour — so a custom `dshBin` never changes how it is launched.
pub fn supports_browser_auth(dsh_bin: &Path) -> bool {
    let Some(actual) = dsh_package_version(dsh_bin) else {
        return false;
    };
    let Some(actual) = parse_version(&actual) else {
        return false;
    };
    let Some(threshold) = parse_version(BROWSER_AUTH_SINCE) else {
        return false;
    };
    version_at_least(&actual, &threshold)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_least(actual: &str, threshold: &str) -> bool {
        version_at_least(&parse_version(actual).unwrap(), &parse_version(threshold).unwrap())
    }

    #[test]
    fn gates_at_the_browser_auth_release() {
        assert!(!at_least("0.1.0-rc.6", BROWSER_AUTH_SINCE));
        assert!(!at_least("0.1.0-rc.8", BROWSER_AUTH_SINCE));
        assert!(!at_least("0.1.1-rc.2", BROWSER_AUTH_SINCE));
        assert!(at_least("0.1.2-rc.1", BROWSER_AUTH_SINCE));
        assert!(at_least("0.1.5-rc.2", BROWSER_AUTH_SINCE));
        assert!(at_least("0.2.0", BROWSER_AUTH_SINCE));
    }

    #[test]
    fn release_outranks_its_prereleases() {
        assert!(at_least("0.1.2", "0.1.2-rc.1"));
        assert!(!at_least("0.1.2-alpha.9", "0.1.2-rc.1"));
        assert!(at_least("0.1.2-rc.10", "0.1.2-rc.1"));
    }

    #[test]
    fn unknown_shapes_are_rejected() {
        assert!(parse_version("not-a-version").is_none());
        assert!(parse_version("1.2").is_none());
    }
}
