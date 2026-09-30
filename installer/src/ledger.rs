use crate::legacy_identity;
use crate::payload::{ensure_plain_directory, VerifiedFile};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};

pub const LEDGER_NAME: &str = ".sunday-install-ledger.json";
pub const PRODUCT_NAME: &str = "SUNDAY Launcher";
pub const PRODUCT_GUID: &str = "{429185A0-E03D-4761-B05E-4FDC48B265E8}";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OwnedFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct OwnedShortcut {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct AuthenticodeEvidence {
    pub path: String,
    pub publisher: String,
    pub thumbprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct InstallLedger {
    pub schema_version: u32,
    pub product: String,
    pub product_guid: String,
    pub installation_id: String,
    pub version: String,
    pub root: String,
    pub publisher: String,
    pub files: Vec<OwnedFile>,
    pub shortcuts: Vec<OwnedShortcut>,
    pub signatures: Vec<AuthenticodeEvidence>,
}

#[derive(Debug)]
pub struct RemovalPlan {
    pub root: PathBuf,
    pub ledger: PathBuf,
    files: Vec<PlannedFile>,
    shortcuts: Vec<PlannedFile>,
    directories: Vec<PathBuf>,
}

#[derive(Debug)]
struct PlannedFile {
    path: PathBuf,
    size: u64,
    sha256: String,
}

fn is_reparse(meta: &fs::Metadata) -> bool {
    if meta.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn same_path(left: &Path, right: &Path) -> bool {
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn validate_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn validate_relative(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 512
        || value.contains('\\')
        || !value.is_ascii()
        || value.starts_with('/')
    {
        return Err("install ledger contains an unsafe relative path".into());
    }
    let candidate = Path::new(value);
    for component in candidate.components() {
        match component {
            Component::Normal(part) => {
                let part = part.to_string_lossy();
                if part.is_empty()
                    || part == "."
                    || part == ".."
                    || part.contains(':')
                    || part.ends_with('.')
                    || part.ends_with(' ')
                    || part.chars().any(|ch| ch.is_control())
                {
                    return Err("install ledger contains an unsafe relative path".into());
                }
            }
            _ => return Err("install ledger contains an unsafe relative path".into()),
        }
    }
    Ok(())
}

fn owned_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    validate_relative(relative)?;
    let mut output = root.to_path_buf();
    for component in relative.split('/') {
        output.push(component);
    }
    Ok(output)
}

pub fn hash_file(file: &Path) -> Result<String, String> {
    let mut input = fs::File::open(file)
        .map_err(|error| format!("could not open owned file {}: {error}", file.display()))?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 1024 * 1024];
    loop {
        let count = input
            .read(&mut buffer)
            .map_err(|error| format!("could not read owned file {}: {error}", file.display()))?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    buffer.fill(0);
    Ok(format!("{:x}", digest.finalize()))
}

fn owned_metadata(file: &Path) -> Result<fs::Metadata, String> {
    let metadata = fs::symlink_metadata(file)
        .map_err(|error| format!("could not inspect owned file {}: {error}", file.display()))?;
    if !metadata.is_file() || is_reparse(&metadata) {
        return Err(format!(
            "owned path is not a plain file: {}",
            file.display()
        ));
    }
    if let Some(parent) = file.parent() {
        ensure_plain_directory(parent)?;
    }
    Ok(metadata)
}

fn snapshot_file(file: &Path) -> Result<(u64, String), String> {
    let metadata = owned_metadata(file)?;
    Ok((metadata.len(), hash_file(file)?))
}

pub fn snapshot_shortcut(file: &Path) -> Result<OwnedShortcut, String> {
    let canonical = fs::canonicalize(file).map_err(|error| {
        format!(
            "could not canonicalize shortcut {}: {error}",
            file.display()
        )
    })?;
    let (size, sha256) = snapshot_file(&canonical)?;
    Ok(OwnedShortcut {
        path: canonical.to_string_lossy().to_string(),
        size,
        sha256,
    })
}

pub fn write_ledger(
    root: &Path,
    installation_id: &str,
    version: &str,
    publisher: &str,
    verified_files: &[VerifiedFile],
    shortcuts: &[OwnedShortcut],
    signatures: Vec<AuthenticodeEvidence>,
) -> Result<PathBuf, String> {
    if publisher.trim().is_empty() || installation_id.trim().is_empty() {
        return Err("install ledger identity is incomplete".into());
    }
    ensure_plain_directory(root)?;
    let canonical_root = fs::canonicalize(root)
        .map_err(|error| format!("could not canonicalize install root: {error}"))?;
    let files = verified_files
        .iter()
        .map(|file| OwnedFile {
            path: file.path.clone(),
            size: file.size,
            sha256: file.sha256.clone(),
        })
        .collect::<Vec<_>>();
    let document = InstallLedger {
        schema_version: 1,
        product: PRODUCT_NAME.into(),
        product_guid: PRODUCT_GUID.into(),
        installation_id: installation_id.into(),
        version: version.into(),
        root: canonical_root.to_string_lossy().to_string(),
        publisher: publisher.into(),
        files,
        shortcuts: shortcuts.to_vec(),
        signatures,
    };
    let bytes = serde_json::to_vec_pretty(&document)
        .map_err(|error| format!("could not serialize install ledger: {error}"))?;
    let final_path = canonical_root.join(LEDGER_NAME);
    let temporary = canonical_root.join(format!("{LEDGER_NAME}.tmp"));
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)
        .map_err(|error| format!("could not create install ledger: {error}"))?;
    let write_result = output
        .write_all(&bytes)
        .and_then(|_| output.sync_all())
        .map_err(|error| format!("could not commit install ledger: {error}"));
    drop(output);
    if let Err(error) = write_result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Err(error) = fs::rename(&temporary, &final_path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("could not activate install ledger: {error}"));
    }
    Ok(final_path)
}

pub fn read_ledger(file: &Path) -> Result<InstallLedger, String> {
    let metadata = owned_metadata(file)?;
    if metadata.len() == 0 || metadata.len() > 4 * 1024 * 1024 {
        return Err("install ledger size is invalid".into());
    }
    let bytes =
        fs::read(file).map_err(|error| format!("could not read install ledger: {error}"))?;
    serde_json::from_slice(&bytes).map_err(|error| format!("install ledger is invalid: {error}"))
}

pub fn verify_removal_plan(
    ledger_path: &Path,
    registered_root: &Path,
    registered_installation_id: &str,
    expected_publisher: &str,
    allowed_shortcuts: &[PathBuf],
) -> Result<(InstallLedger, RemovalPlan), String> {
    let ledger = read_ledger(ledger_path)?;
    let legacy_ledger = legacy_identity::is_product(&ledger.product);
    if ledger.schema_version != 1
        || (ledger.product != PRODUCT_NAME && !legacy_ledger)
        || ledger.product_guid != PRODUCT_GUID
        || ledger.installation_id != registered_installation_id
        || ledger.publisher != expected_publisher
    {
        return Err(
            "install ledger identity does not match the registered SUNDAY Launcher installation"
                .into(),
        );
    }
    let canonical_root = fs::canonicalize(registered_root).map_err(|error| {
        format!("could not canonicalize registered SUNDAY Launcher root: {error}")
    })?;
    let expected_ledger_name = if legacy_ledger {
        legacy_identity::LEDGER_NAME
    } else {
        LEDGER_NAME
    };
    if !same_path(&canonical_root, Path::new(&ledger.root))
        || !same_path(ledger_path, &canonical_root.join(expected_ledger_name))
    {
        return Err(
            "install ledger root does not match the registered SUNDAY Launcher installation".into(),
        );
    }
    ensure_plain_directory(&canonical_root)?;
    let mut names = HashSet::new();
    let mut files = Vec::new();
    let mut directories = HashSet::new();
    for owned in &ledger.files {
        if !validate_sha256(&owned.sha256) || !names.insert(owned.path.to_ascii_lowercase()) {
            return Err("install ledger contains invalid or duplicate file evidence".into());
        }
        let target = owned_path(&canonical_root, &owned.path)?;
        if target.exists() {
            let metadata = owned_metadata(&target)?;
            if metadata.len() != owned.size || hash_file(&target)? != owned.sha256 {
                return Err(format!(
                    "owned SUNDAY Launcher file was modified and will not be removed: {}",
                    owned.path
                ));
            }
        }
        let mut parent = target.parent();
        while let Some(directory) = parent {
            if same_path(directory, &canonical_root) {
                break;
            }
            if !directory.starts_with(&canonical_root) {
                return Err("install ledger escaped the SUNDAY Launcher root".into());
            }
            directories.insert(directory.to_path_buf());
            parent = directory.parent();
        }
        files.push(PlannedFile {
            path: target,
            size: owned.size,
            sha256: owned.sha256.clone(),
        });
    }
    let has_current_launcher = names.contains("sunday.exe");
    let has_legacy_launcher = names.contains(&legacy_identity::MAIN_BINARY.to_ascii_lowercase());
    if (legacy_ledger && (!has_legacy_launcher || has_current_launcher))
        || (!legacy_ledger && (!has_current_launcher || has_legacy_launcher))
    {
        return Err(
            "install ledger executable evidence does not match its product identity".into(),
        );
    }
    let required_manifest = if legacy_ledger {
        legacy_identity::INSTALL_MANIFEST
    } else {
        "sunday-install-manifest.json"
    };
    for required in ["node.exe", "uninstall.exe", required_manifest] {
        if !names.contains(required) {
            return Err(format!(
                "install ledger is missing required ownership evidence: {required}"
            ));
        }
    }

    let mut shortcuts = Vec::new();
    let mut shortcut_names = HashSet::new();
    for shortcut in &ledger.shortcuts {
        if !validate_sha256(&shortcut.sha256) {
            return Err("install ledger contains invalid shortcut evidence".into());
        }
        let target = PathBuf::from(&shortcut.path);
        let allowed = allowed_shortcuts.iter().any(|candidate| {
            fs::canonicalize(candidate)
                .map(|canonical| same_path(&canonical, &target))
                .unwrap_or_else(|_| same_path(candidate, &target))
        });
        if !target.is_absolute()
            || !allowed
            || !shortcut_names.insert(target.to_string_lossy().to_ascii_lowercase())
        {
            return Err("install ledger contains an unexpected shortcut path".into());
        }
        if target.exists() {
            let metadata = owned_metadata(&target)?;
            if metadata.len() != shortcut.size || hash_file(&target)? != shortcut.sha256 {
                return Err(format!(
                    "SUNDAY Launcher shortcut was modified and will not be removed: {}",
                    target.display()
                ));
            }
        }
        shortcuts.push(PlannedFile {
            path: target,
            size: shortcut.size,
            sha256: shortcut.sha256.clone(),
        });
    }

    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    Ok((
        ledger,
        RemovalPlan {
            root: canonical_root,
            ledger: ledger_path.to_path_buf(),
            files,
            shortcuts,
            directories,
        },
    ))
}

fn remove_plain_file_if_present(file: &Path) -> Result<(), String> {
    match fs::symlink_metadata(file) {
        Ok(metadata) => {
            if !metadata.is_file() || is_reparse(&metadata) {
                return Err(format!(
                    "refusing to remove non-plain owned path: {}",
                    file.display()
                ));
            }
            fs::remove_file(file)
                .map_err(|error| format!("could not remove owned file {}: {error}", file.display()))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "could not inspect owned file {}: {error}",
            file.display()
        )),
    }
}

fn remove_verified_file_if_present(file: &PlannedFile) -> Result<(), String> {
    match fs::symlink_metadata(&file.path) {
        Ok(metadata) => {
            if !metadata.is_file()
                || is_reparse(&metadata)
                || metadata.len() != file.size
                || hash_file(&file.path)? != file.sha256
            {
                return Err(format!(
                    "owned file changed after removal preflight and was preserved: {}",
                    file.path.display()
                ));
            }
            fs::remove_file(&file.path).map_err(|error| {
                format!(
                    "could not remove owned file {}: {error}",
                    file.path.display()
                )
            })
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!(
            "could not inspect owned file {}: {error}",
            file.path.display()
        )),
    }
}

pub fn execute_removal(plan: &RemovalPlan) -> Result<(), String> {
    for shortcut in &plan.shortcuts {
        remove_verified_file_if_present(shortcut)?;
    }
    for directory in plan
        .shortcuts
        .iter()
        .filter_map(|shortcut| shortcut.path.parent())
    {
        if directory
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| {
                name.eq_ignore_ascii_case("SUNDAY Launcher")
                    || name.eq_ignore_ascii_case(legacy_identity::START_MENU_FOLDER)
            })
            .unwrap_or(false)
        {
            let _ = fs::remove_dir(directory);
        }
    }
    for file in &plan.files {
        if file
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("uninstall.exe"))
            .unwrap_or(false)
        {
            continue;
        }
        remove_verified_file_if_present(file)?;
    }
    Ok(())
}

pub fn finish_removal(plan: &RemovalPlan) -> Result<bool, String> {
    for file in &plan.files {
        if file
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .map(|name| name.eq_ignore_ascii_case("uninstall.exe"))
            .unwrap_or(false)
        {
            remove_verified_file_if_present(file)?;
        }
    }
    remove_plain_file_if_present(&plan.ledger)?;
    for directory in &plan.directories {
        match fs::remove_dir(directory) {
            Ok(()) => {}
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
                ) => {}
            Err(error) => {
                return Err(format!(
                    "could not remove empty SUNDAY Launcher directory {}: {error}",
                    directory.display()
                ))
            }
        }
    }
    match fs::remove_dir(&plan.root) {
        Ok(()) => Ok(false),
        Err(error)
            if matches!(
                error.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::DirectoryNotEmpty
            ) =>
        {
            Ok(plan.root.exists())
        }
        Err(error) => Err(format!(
            "could not remove SUNDAY Launcher root {}: {error}",
            plan.root.display()
        )),
    }
}

pub fn rollback_new_install(root: &Path, files: &[VerifiedFile], shortcuts: &[OwnedShortcut]) {
    for shortcut in shortcuts {
        let planned = PlannedFile {
            path: PathBuf::from(&shortcut.path),
            size: shortcut.size,
            sha256: shortcut.sha256.clone(),
        };
        let _ = remove_verified_file_if_present(&planned);
        if let Some(directory) = planned.path.parent() {
            if directory
                .file_name()
                .and_then(|name| name.to_str())
                .map(|name| {
                    name.eq_ignore_ascii_case("SUNDAY Launcher")
                        || name.eq_ignore_ascii_case(legacy_identity::START_MENU_FOLDER)
                })
                .unwrap_or(false)
            {
                let _ = fs::remove_dir(directory);
            }
        }
    }
    let ledger = root.join(LEDGER_NAME);
    let _ = remove_plain_file_if_present(&ledger);
    let temporary_ledger = root.join(format!("{LEDGER_NAME}.tmp"));
    let _ = remove_plain_file_if_present(&temporary_ledger);
    let mut directories = HashSet::new();
    for owned in files {
        if let Ok(file) = owned_path(root, &owned.path) {
            let planned = PlannedFile {
                path: file.clone(),
                size: owned.size,
                sha256: owned.sha256.clone(),
            };
            let _ = remove_verified_file_if_present(&planned);
            let mut parent = file.parent();
            while let Some(directory) = parent {
                if same_path(directory, root) {
                    break;
                }
                directories.insert(directory.to_path_buf());
                parent = directory.parent();
            }
        }
    }
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    for directory in directories {
        let _ = fs::remove_dir(directory);
    }
    let _ = fs::remove_dir(root);
}

#[cfg(test)]
mod tests {
    use super::{
        execute_removal, hash_file, read_ledger, snapshot_shortcut, verify_removal_plan,
        write_ledger, AuthenticodeEvidence,
    };
    use crate::legacy_identity;
    use crate::payload::VerifiedFile;
    use sha2::{Digest, Sha256};
    use std::fs;

    #[test]
    fn ledger_removes_only_verified_owned_files_and_preserves_unknown_files() {
        let root = std::env::temp_dir().join(format!(
            "sunday-ledger-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut files = Vec::new();
        for name in [
            "Sunday.exe",
            "node.exe",
            "uninstall.exe",
            "sunday-install-manifest.json",
        ] {
            let bytes = format!("owned-{name}").into_bytes();
            fs::write(root.join(name), &bytes).unwrap();
            files.push(VerifiedFile {
                path: name.into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
            });
        }
        fs::write(root.join("user-note.txt"), b"preserve").unwrap();
        let shortcut = root
            .parent()
            .unwrap()
            .join(format!("sunday-test-{}.lnk", std::process::id()));
        fs::write(&shortcut, b"shortcut").unwrap();
        let shortcut_evidence = snapshot_shortcut(&shortcut).unwrap();
        let ledger = write_ledger(
            &root,
            "test-install-id",
            "1.8.14",
            "CN=SUNDAY Test",
            &files,
            std::slice::from_ref(&shortcut_evidence),
            vec![AuthenticodeEvidence {
                path: "Sunday.exe".into(),
                publisher: "CN=SUNDAY Test".into(),
                thumbprint: "A".repeat(40),
            }],
        )
        .unwrap();
        let (_, plan) = verify_removal_plan(
            &ledger,
            &root,
            "test-install-id",
            "CN=SUNDAY Test",
            std::slice::from_ref(&shortcut),
        )
        .unwrap();
        execute_removal(&plan).unwrap();
        assert!(super::finish_removal(&plan).unwrap());
        assert_eq!(fs::read(root.join("user-note.txt")).unwrap(), b"preserve");
        assert!(!shortcut.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ledger_refuses_modified_owned_content_before_deletion() {
        let root = std::env::temp_dir().join(format!(
            "sunday-ledger-tamper-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut files = Vec::new();
        for name in [
            "Sunday.exe",
            "node.exe",
            "uninstall.exe",
            "sunday-install-manifest.json",
        ] {
            let bytes = format!("owned-{name}").into_bytes();
            fs::write(root.join(name), &bytes).unwrap();
            files.push(VerifiedFile {
                path: name.into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
            });
        }
        let ledger = write_ledger(
            &root,
            "test-install-id",
            "1.8.14",
            "CN=SUNDAY Test",
            &files,
            &[],
            vec![],
        )
        .unwrap();
        fs::write(root.join("Sunday.exe"), b"tampered").unwrap();
        assert!(
            verify_removal_plan(&ledger, &root, "test-install-id", "CN=SUNDAY Test", &[],)
                .unwrap_err()
                .contains("modified")
        );
        assert!(root.join("node.exe").exists());
        assert!(hash_file(&root.join("node.exe")).is_ok());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ledger_accepts_pre_sunday_executable_evidence_for_uninstall_only() {
        let root = std::env::temp_dir().join(format!(
            "sunday-ledger-legacy-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let mut files = Vec::new();
        for name in [
            legacy_identity::MAIN_BINARY,
            "node.exe",
            "uninstall.exe",
            legacy_identity::INSTALL_MANIFEST,
        ] {
            let bytes = format!("legacy-owned-{name}").into_bytes();
            fs::write(root.join(name), &bytes).unwrap();
            files.push(VerifiedFile {
                path: name.into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
            });
        }
        let ledger = write_ledger(
            &root,
            "legacy-install-id",
            "1.8.14",
            "CN=SUNDAY Test",
            &files,
            &[],
            vec![],
        )
        .unwrap();
        let mut document = read_ledger(&ledger).unwrap();
        document.product = legacy_identity::PRODUCT_NAME.into();
        fs::write(&ledger, serde_json::to_vec_pretty(&document).unwrap()).unwrap();
        let legacy_ledger = root.join(legacy_identity::LEDGER_NAME);
        fs::rename(&ledger, &legacy_ledger).unwrap();
        let legacy_ledger = fs::canonicalize(&legacy_ledger).unwrap();
        verify_removal_plan(
            &legacy_ledger,
            &root,
            "legacy-install-id",
            "CN=SUNDAY Test",
            &[],
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }
}
