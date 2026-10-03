// Windows shell integration: registry, shortcuts, the native folder picker,
// WebView2 detection and a few process helpers.

use serde::Deserialize;
use std::path::{Path, PathBuf};
use std::process::Command;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use windows::core::{Interface, PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, ERROR_CANCELLED, ERROR_FILE_NOT_FOUND, ERROR_SUCCESS, HWND,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, IPersistFile, CLSCTX_INPROC_SERVER,
    COINIT_APARTMENTTHREADED,
};
use windows::Win32::System::Registry::{
    RegCloseKey, RegCreateKeyExW, RegDeleteTreeW, RegGetValueW, RegSetValueExW, HKEY,
    HKEY_CURRENT_USER, REG_CREATE_KEY_DISPOSITION, REG_OPTION_NON_VOLATILE, REG_VALUE_TYPE,
    RRF_RT_REG_SZ,
};
use windows::Win32::System::SystemInformation::GetSystemDirectoryW;
use windows::Win32::System::Threading::{CreateProcessW, PROCESS_INFORMATION, STARTUPINFOW};
use windows::Win32::UI::Shell::Common::ITEMIDLIST;
use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileDialog, IShellItem, IShellLinkW, SHBrowseForFolderW,
    SHCreateItemFromParsingName, SHGetPathFromIDListW, SHGetSpecialFolderPathW, ShellExecuteW,
    ShellLink, BROWSEINFOW, SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

// ------------------------------------------------------------------ helpers

#[cfg(debug_assertions)]
pub fn log_str(s: &str) {
    if std::env::var_os("SUNDAY_SETUP_LOG").is_some() {
        let line = format!("[sunday-setup/shell] {s}\r\n");
        let p = std::env::temp_dir().join("SundaySetup.log");
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
        {
            use std::io::Write;
            let _ = f.write_all(line.as_bytes());
        }
    }
}

#[cfg(not(debug_assertions))]
pub fn log_str(_: &str) {}

pub fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn wide_to_string(p: PWSTR) -> String {
    unsafe {
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.as_ptr() as *const core::ffi::c_void));
        s
    }
}

pub fn local_app_data() -> Option<PathBuf> {
    let mut buf = [0u16; 260];
    unsafe {
        if SHGetSpecialFolderPathW(None, &mut buf, CSIDL_LOCALAPPDATA as i32, true).as_bool() {
            let path = wide_buf_to_path(&buf);
            if path.is_absolute() {
                return Some(path);
            }
        }
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let path = PathBuf::from(local);
        if path.is_absolute() {
            return Some(path);
        }
    }
    None
}

pub fn special_folder(csidl: u32) -> PathBuf {
    let mut buf = [0u16; 260];
    unsafe {
        if SHGetSpecialFolderPathW(None, &mut buf, csidl as i32, true).as_bool() {
            return wide_buf_to_path(&buf);
        }
    }
    PathBuf::new()
}

fn wide_buf_to_path(buf: &[u16; 260]) -> PathBuf {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    PathBuf::from(String::from_utf16_lossy(&buf[..len]))
}

pub const CSIDL_PROGRAMS: u32 = 2;
pub const CSIDL_DESKTOPDIRECTORY: u32 = 16;
const CSIDL_LOCALAPPDATA: u32 = 28;
const UNINSTALL_KEY: &str =
    "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\SundayLauncher";
const MANUFACTURER_KEY: &str = "Software\\SADINKAI\\SundayLauncher";

#[derive(Clone, Debug)]
pub struct InstallRegistration {
    pub installation_id: String,
    pub product_guid: String,
    pub install_location: PathBuf,
    pub ledger_path: PathBuf,
    pub publisher: String,
    pub main_binary_name: String,
    pub version: String,
    pub legacy_identity: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub struct AuthenticodeIdentity {
    pub status: String,
    pub subject: String,
    pub thumbprint: String,
}

// ------------------------------------------------------------------ registry

fn reg_create(subkey: &str) -> Result<HKEY, String> {
    let wsub = to_wide(subkey);
    let mut hkey = HKEY::default();
    let r = unsafe {
        RegCreateKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(wsub.as_ptr()),
            None,
            None,
            REG_OPTION_NON_VOLATILE,
            windows::Win32::System::Registry::KEY_SET_VALUE,
            None,
            &mut hkey,
            None::<*mut REG_CREATE_KEY_DISPOSITION>,
        )
    };
    if r != ERROR_SUCCESS {
        return Err(format!("could not open registry key {subkey}"));
    }
    Ok(hkey)
}

fn reg_set_string(hkey: HKEY, name: &str, value: &str) -> Result<(), String> {
    let wname = to_wide(name);
    let mut wvalue = to_wide(value);
    let ok = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(wname.as_ptr()),
            None,
            REG_VALUE_TYPE(1u32), // REG_SZ
            Some(std::slice::from_raw_parts_mut(
                wvalue.as_mut_ptr().cast::<u8>(),
                wvalue.len() * 2,
            )),
        ) == ERROR_SUCCESS
    };
    if ok {
        Ok(())
    } else {
        Err(format!("could not write registry value {name}"))
    }
}

fn reg_set_dword(hkey: HKEY, name: &str, value: u32) -> Result<(), String> {
    let wname = to_wide(name);
    let bytes = value.to_le_bytes();
    let ok = unsafe {
        RegSetValueExW(
            hkey,
            PCWSTR(wname.as_ptr()),
            None,
            REG_VALUE_TYPE(4u32), // REG_DWORD
            Some(&bytes),
        ) == ERROR_SUCCESS
    };
    if ok {
        Ok(())
    } else {
        Err(format!("could not write registry value {name}"))
    }
}

/// Writes the standard "Add/Remove Programs" entries (per-user install).
pub fn write_install_entries(
    install_dir: &Path,
    exe: &Path,
    uninstall: &Path,
    version: &str,
    estimated_kb: u32,
    installation_id: &str,
    product_guid: &str,
    ledger_path: &Path,
    publisher: &str,
) -> Result<(), String> {
    if reg_query_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallLocation").is_some()
        || reg_query_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallationId").is_some()
        || reg_query_string(HKEY_CURRENT_USER, MANUFACTURER_KEY, "").is_some()
        || reg_query_string(
            HKEY_CURRENT_USER,
            crate::legacy_identity::UNINSTALL_KEY,
            "InstallLocation",
        )
        .is_some()
        || reg_query_string(
            HKEY_CURRENT_USER,
            crate::legacy_identity::MANUFACTURER_KEY,
            "",
        )
        .is_some()
    {
        return Err("A SUNDAY Launcher installation registration already exists; setup will not overwrite its ownership identity.".into());
    }
    let hkey = reg_create(UNINSTALL_KEY)?;
    let result = (|| -> Result<(), String> {
        let dir_s = install_dir.to_string_lossy().to_string();
        let exe_s = exe.to_string_lossy().to_string();
        let un_s = uninstall.to_string_lossy().to_string();
        let ledger_s = ledger_path.to_string_lossy().to_string();
        reg_set_string(hkey, "DisplayName", "SUNDAY Launcher")?;
        reg_set_string(hkey, "DisplayVersion", version)?;
        reg_set_string(hkey, "Publisher", publisher)?;
        reg_set_string(hkey, "InstallLocation", &dir_s)?;
        reg_set_string(hkey, "DisplayIcon", &exe_s)?;
        reg_set_string(hkey, "UninstallString", &format!("\"{un_s}\" --uninstall"))?;
        reg_set_string(hkey, "MainBinaryName", "Sunday.exe")?;
        reg_set_string(hkey, "InstallationId", installation_id)?;
        reg_set_string(hkey, "ProductGuid", product_guid)?;
        reg_set_string(hkey, "LedgerPath", &ledger_s)?;
        reg_set_dword(hkey, "NoModify", 1)?;
        reg_set_dword(hkey, "NoRepair", 1)?;
        reg_set_dword(hkey, "EstimatedSize", estimated_kb)?;
        Ok(())
    })();
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    if let Err(error) = result {
        let _ = delete_registry_tree(UNINSTALL_KEY);
        return Err(error);
    }

    // Parity with the old installer's manufacturer key.
    let hkey = match reg_create(MANUFACTURER_KEY) {
        Ok(key) => key,
        Err(error) => {
            let _ = delete_registry_tree(UNINSTALL_KEY);
            return Err(error);
        }
    };
    let result = (|| -> Result<(), String> {
        reg_set_string(hkey, "", &install_dir.to_string_lossy())?;
        reg_set_string(hkey, "InstallationId", installation_id)?;
        reg_set_string(hkey, "ProductGuid", product_guid)
    })();
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    if let Err(error) = result {
        let _ = delete_registry_tree(MANUFACTURER_KEY);
        let _ = delete_registry_tree(UNINSTALL_KEY);
        return Err(error);
    }
    Ok(())
}

fn reg_query_string(root: HKEY, subkey: &str, value: &str) -> Option<String> {
    let wsub = to_wide(subkey);
    let wname = to_wide(value);
    let mut buf = [0u16; 512];
    let mut len = (buf.len() * 2) as u32;
    let ok = unsafe {
        RegGetValueW(
            root,
            PCWSTR(wsub.as_ptr()),
            PCWSTR(wname.as_ptr()),
            RRF_RT_REG_SZ,
            None,
            Some(buf.as_mut_ptr().cast::<core::ffi::c_void>()),
            Some(&mut len),
        ) == ERROR_SUCCESS
    };
    if !ok {
        return None;
    }
    let chars = ((len as usize) / 2).min(buf.len());
    Some(
        String::from_utf16_lossy(&buf[..chars])
            .trim_end_matches('\0')
            .to_string(),
    )
}

fn delete_registry_tree(subkey: &str) -> Result<(), String> {
    let wide = to_wide(subkey);
    let result = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, PCWSTR(wide.as_ptr())) };
    if result == ERROR_SUCCESS || result == ERROR_FILE_NOT_FOUND {
        Ok(())
    } else {
        Err(format!("could not remove registry key {subkey}"))
    }
}

fn read_install_registration_from(
    uninstall_key: &str,
    legacy_identity: bool,
) -> Result<InstallRegistration, String> {
    let required = |name: &str| {
        reg_query_string(HKEY_CURRENT_USER, uninstall_key, name)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| format!("SUNDAY Launcher registration is missing {name}"))
    };
    Ok(InstallRegistration {
        installation_id: required("InstallationId")?,
        product_guid: required("ProductGuid")?,
        install_location: PathBuf::from(required("InstallLocation")?),
        ledger_path: PathBuf::from(required("LedgerPath")?),
        publisher: required("Publisher")?,
        main_binary_name: required("MainBinaryName")?,
        version: required("DisplayVersion")?,
        legacy_identity,
    })
}

pub fn read_install_registration() -> Result<InstallRegistration, String> {
    let canonical_present = reg_query_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallLocation")
        .is_some()
        || reg_query_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallationId").is_some();
    if canonical_present {
        return read_install_registration_from(UNINSTALL_KEY, false);
    }
    read_install_registration_from(crate::legacy_identity::UNINSTALL_KEY, true)
}

pub fn migrate_legacy_registration(
    registration: &InstallRegistration,
) -> Result<InstallRegistration, String> {
    if !registration.legacy_identity {
        return Ok(registration.clone());
    }
    if reg_query_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallLocation").is_some()
        || reg_query_string(HKEY_CURRENT_USER, UNINSTALL_KEY, "InstallationId").is_some()
        || reg_query_string(HKEY_CURRENT_USER, MANUFACTURER_KEY, "").is_some()
    {
        return Err("A canonical SUNDAY Launcher registration already exists; legacy registration was preserved.".into());
    }

    let uninstall = registration.install_location.join("uninstall.exe");
    let launcher = registration
        .install_location
        .join(&registration.main_binary_name);
    let hkey = reg_create(UNINSTALL_KEY)?;
    let result = (|| -> Result<(), String> {
        reg_set_string(hkey, "DisplayName", "SUNDAY Launcher")?;
        reg_set_string(hkey, "DisplayVersion", &registration.version)?;
        reg_set_string(hkey, "Publisher", &registration.publisher)?;
        reg_set_string(
            hkey,
            "InstallLocation",
            &registration.install_location.to_string_lossy(),
        )?;
        reg_set_string(hkey, "DisplayIcon", &launcher.to_string_lossy())?;
        reg_set_string(
            hkey,
            "UninstallString",
            &format!("\"{}\" --uninstall", uninstall.to_string_lossy()),
        )?;
        reg_set_string(hkey, "MainBinaryName", &registration.main_binary_name)?;
        reg_set_string(hkey, "InstallationId", &registration.installation_id)?;
        reg_set_string(hkey, "ProductGuid", &registration.product_guid)?;
        reg_set_string(
            hkey,
            "LedgerPath",
            &registration.ledger_path.to_string_lossy(),
        )?;
        reg_set_dword(hkey, "NoModify", 1)?;
        reg_set_dword(hkey, "NoRepair", 1)
    })();
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    if let Err(error) = result {
        let _ = delete_registry_tree(UNINSTALL_KEY);
        return Err(error);
    }

    let hkey = match reg_create(MANUFACTURER_KEY) {
        Ok(key) => key,
        Err(error) => {
            let _ = delete_registry_tree(UNINSTALL_KEY);
            return Err(error);
        }
    };
    let result = (|| -> Result<(), String> {
        reg_set_string(hkey, "", &registration.install_location.to_string_lossy())?;
        reg_set_string(hkey, "InstallationId", &registration.installation_id)?;
        reg_set_string(hkey, "ProductGuid", &registration.product_guid)
    })();
    unsafe {
        let _ = RegCloseKey(hkey);
    }
    if let Err(error) = result {
        let _ = delete_registry_tree(MANUFACTURER_KEY);
        let _ = delete_registry_tree(UNINSTALL_KEY);
        return Err(error);
    }

    let migrated = read_install_registration_from(UNINSTALL_KEY, false)?;
    if migrated.installation_id != registration.installation_id
        || migrated.product_guid != registration.product_guid
        || !migrated
            .install_location
            .to_string_lossy()
            .eq_ignore_ascii_case(&registration.install_location.to_string_lossy())
        || !migrated
            .ledger_path
            .to_string_lossy()
            .eq_ignore_ascii_case(&registration.ledger_path.to_string_lossy())
    {
        let _ = delete_registry_tree(MANUFACTURER_KEY);
        let _ = delete_registry_tree(UNINSTALL_KEY);
        return Err("SUNDAY Launcher could not verify the migrated registration; legacy registration was preserved.".into());
    }
    delete_registry_tree(crate::legacy_identity::MANUFACTURER_KEY)?;
    delete_registry_tree(crate::legacy_identity::UNINSTALL_KEY)?;
    Ok(migrated)
}

pub fn remove_install_registration(
    installation_id: &str,
    product_guid: &str,
    install_location: &Path,
) -> Result<(), String> {
    let registration = read_install_registration()?;
    let same_root = registration
        .install_location
        .to_string_lossy()
        .eq_ignore_ascii_case(&install_location.to_string_lossy());
    if registration.installation_id != installation_id
        || registration.product_guid != product_guid
        || !same_root
    {
        return Err(
            "SUNDAY Launcher registration changed during removal; registry entries were preserved."
                .into(),
        );
    }
    let manufacturer_id =
        reg_query_string(HKEY_CURRENT_USER, MANUFACTURER_KEY, "InstallationId").unwrap_or_default();
    let manufacturer_guid =
        reg_query_string(HKEY_CURRENT_USER, MANUFACTURER_KEY, "ProductGuid").unwrap_or_default();
    let manufacturer_root =
        reg_query_string(HKEY_CURRENT_USER, MANUFACTURER_KEY, "").unwrap_or_default();
    if manufacturer_id != installation_id
        || manufacturer_guid != product_guid
        || !manufacturer_root.eq_ignore_ascii_case(&install_location.to_string_lossy())
    {
        return Err(
            "SUNDAY Launcher manufacturer registration does not match the install ledger.".into(),
        );
    }
    delete_registry_tree(MANUFACTURER_KEY)?;
    delete_registry_tree(UNINSTALL_KEY)
}

pub fn verify_authenticode(
    file: &Path,
    expected_publisher: &str,
) -> Result<AuthenticodeIdentity, String> {
    if expected_publisher.trim().is_empty() || !file.is_absolute() {
        return Err("SUNDAY Launcher Authenticode identity is not configured.".into());
    }
    let mut system = [0u16; 32768];
    let length = unsafe { GetSystemDirectoryW(Some(&mut system)) } as usize;
    if length == 0 || length >= system.len() {
        return Err("Could not resolve the Windows system directory.".into());
    }
    let powershell = PathBuf::from(String::from_utf16_lossy(&system[..length]))
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    let script = concat!(
        "$ErrorActionPreference='Stop';",
        "Import-Module (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1') -Force;",
        "$s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath $env:SUNDAY_VERIFY_FILE;",
        "[pscustomobject]@{Status=[string]$s.Status;Subject=if($s.SignerCertificate){[string]$s.SignerCertificate.Subject}else{''};Thumbprint=if($s.SignerCertificate){[string]$s.SignerCertificate.Thumbprint}else{''}}|ConvertTo-Json -Compress"
    );
    let mut command = Command::new(&powershell);
    command
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .env("SUNDAY_VERIFY_FILE", file)
        .env_remove("PSModulePath");
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = command
        .output()
        .map_err(|_| "Authenticode verification could not be started.".to_string())?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return Err("Authenticode verification could not be completed.".into());
    }
    let mut identity: AuthenticodeIdentity = serde_json::from_slice(&output.stdout)
        .map_err(|_| "Authenticode verifier returned an invalid result.".to_string())?;
    identity.thumbprint.make_ascii_uppercase();
    if identity.status != "Valid" {
        return Err("SUNDAY Launcher Authenticode signature is not valid.".into());
    }
    if identity.subject != expected_publisher {
        return Err(
            "SUNDAY Launcher Authenticode publisher does not match the embedded identity.".into(),
        );
    }
    Ok(identity)
}

// ------------------------------------------------------------------ shortcuts

pub fn create_shortcut(
    lnk: &Path,
    target: &Path,
    workdir: &Path,
    description: &str,
) -> Result<(), String> {
    fn shell_path(path: &Path) -> String {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = value.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            value.into_owned()
        }
    }

    let target_text = to_wide(&shell_path(target));
    let workdir_text = to_wide(&shell_path(workdir));
    let description_text = to_wide(description);
    let shortcut_text = to_wide(&shell_path(lnk));
    unsafe {
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)
            .map_err(|e| format!("shortcut object creation failed\n{e}"))?;
        link.SetPath(PCWSTR(target_text.as_ptr()))
            .map_err(|e| format!("shortcut target setup failed\n{e}"))?;
        link.SetWorkingDirectory(PCWSTR(workdir_text.as_ptr()))
            .map_err(|e| format!("shortcut working-directory setup failed\n{e}"))?;
        link.SetDescription(PCWSTR(description_text.as_ptr()))
            .map_err(|e| format!("shortcut description setup failed\n{e}"))?;
        let persist: IPersistFile = link
            .cast()
            .map_err(|e| format!("shortcut persistence setup failed\n{e}"))?;
        persist
            .Save(PCWSTR(shortcut_text.as_ptr()), true)
            .map_err(|e| format!("could not save shortcut {}\n{e}", lnk.display()))?;
    }
    Ok(())
}

#[cfg(test)]
#[allow(clippy::items_after_test_module)]
mod shortcut_tests {
    use super::create_shortcut;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};

    #[test]
    fn shell_link_is_created_for_an_existing_target() {
        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let root = std::env::temp_dir().join(format!("sunday-shortcut-test-{stamp}"));
        fs::create_dir(&root).expect("create shortcut test root");
        let workdir = root.join("SUNDAY Launcher Qualification 1.8.17");
        fs::create_dir(&workdir).expect("create spaced work directory");
        let target = workdir.join("Sunday.exe");
        fs::copy(
            std::env::current_exe().expect("current executable"),
            &target,
        )
        .expect("stage shortcut target");
        let shortcut_dir = root.join("Start Menu").join("SUNDAY Launcher");
        fs::create_dir_all(&shortcut_dir).expect("create spaced shortcut directory");
        let shortcut = shortcut_dir.join("SUNDAY Launcher.lnk");
        let verbatim =
            |path: &std::path::Path| PathBuf::from(format!(r"\\?\{}", path.to_string_lossy()));
        create_shortcut(
            &verbatim(&shortcut),
            &verbatim(&target),
            &verbatim(&workdir),
            "SUNDAY shortcut qualification",
        )
        .expect("create Windows shortcut from verbatim paths");
        assert!(shortcut.is_file());
        fs::remove_file(shortcut).expect("remove shortcut");
        fs::remove_dir(shortcut_dir).expect("remove shortcut leaf");
        fs::remove_dir(root.join("Start Menu")).expect("remove shortcut parent");
        fs::remove_file(target).expect("remove shortcut target");
        fs::remove_dir(workdir).expect("remove work directory");
        fs::remove_dir(root).expect("remove shortcut test root");
    }
}

// ------------------------------------------------------------------ folder picker

/// Opens the real, modern Windows folder picker (IFileDialog) with a
/// SHBrowseForFolder fallback. Returns the chosen folder, or None on cancel.
pub fn pick_folder(owner: HWND, title: &str, start_dir: &Path) -> Option<PathBuf> {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let dialog: IFileDialog =
            match CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER) {
                Ok(d) => d,
                Err(e) => {
                    log_str(&format!("pick_folder: CoCreateInstance failed: {e}"));
                    return browse_folder_fallback(owner, title, start_dir);
                }
            };
        log_str("pick_folder: dialog created");

        let mut options = match dialog.GetOptions() {
            Ok(o) => o,
            Err(e) => {
                log_str(&format!("pick_folder: GetOptions failed: {e}"));
                return browse_folder_fallback(owner, title, start_dir);
            }
        };
        options |= windows::Win32::UI::Shell::FOS_PICKFOLDERS
            | windows::Win32::UI::Shell::FOS_FORCEFILESYSTEM
            | windows::Win32::UI::Shell::FOS_PATHMUSTEXIST;
        if dialog.SetOptions(options).is_err() {
            log_str("pick_folder: SetOptions failed");
            return browse_folder_fallback(owner, title, start_dir);
        }
        let _ = dialog.SetTitle(PCWSTR(to_wide(title).as_ptr()));
        if let Some(parent) = start_dir.parent() {
            log_str("pick_folder: creating item from parsing name");
            if let Ok(item) = SHCreateItemFromParsingName::<_, _, IShellItem>(
                PCWSTR(to_wide(&parent.to_string_lossy()).as_ptr()),
                None,
            ) {
                let _ = dialog.SetFolder(&item);
            }
        }
        log_str("pick_folder: calling Show");
        match dialog.Show(Some(owner)) {
            Ok(()) => {}
            Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => {
                log_str("pick_folder: cancelled");
                return None;
            }
            Err(e) => {
                log_str(&format!("pick_folder: Show failed {e}, falling back"));
                return browse_folder_fallback(owner, title, start_dir);
            }
        }
        log_str("pick_folder: Show returned");
        let item: IShellItem = match dialog.GetResult() {
            Ok(item) => item,
            Err(_) => return None,
        };
        let name = item.GetDisplayName(SIGDN_FILESYSPATH).ok()?;
        let s = wide_to_string(name);
        if s.is_empty() {
            None
        } else {
            Some(PathBuf::from(s))
        }
    }
}

unsafe fn browse_folder_fallback(owner: HWND, title: &str, start: &Path) -> Option<PathBuf> {
    log_str("pick_folder: using SHBrowseForFolder fallback");
    let wtitle = to_wide(title);
    let wstart = to_wide(&start.to_string_lossy());
    let bi = BROWSEINFOW {
        hwndOwner: owner,
        pidlRoot: std::ptr::null_mut(),
        pszDisplayName: PWSTR::null(),
        lpszTitle: PCWSTR(wtitle.as_ptr()),
        ulFlags: 0x0011, // BIF_RETURNONLYFSDIRS | BIF_NEWDIALOGSTYLE
        lpfn: None,
        lParam: lparam_of(&wstart),
        iImage: 0,
    };
    let pidl: *mut ITEMIDLIST = SHBrowseForFolderW(&bi);
    if pidl.is_null() {
        return None;
    }
    let mut buf = [0u16; 260];
    let got = SHGetPathFromIDListW(pidl, &mut buf);
    CoTaskMemFree(Some(pidl.cast::<core::ffi::c_void>()));
    if !got.as_bool() {
        return None;
    }
    let s = String::from_utf16_lossy(&buf[..buf.iter().position(|c| *c == 0).unwrap_or(buf.len())]);
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn lparam_of(w: &[u16]) -> windows::Win32::Foundation::LPARAM {
    // Points at the wide string kept alive by the caller for the dialog.
    windows::Win32::Foundation::LPARAM(w.as_ptr() as isize)
}

// ------------------------------------------------------------------ misc

pub fn launch_app(exe: &Path, workdir: &Path) -> bool {
    if !exe.is_file() {
        log_str(&format!(
            "launch_app: {} does not exist - cannot start SUNDAY Launcher",
            exe.display()
        ));
        return false;
    }
    // A just-written executable can be transiently blocked by antivirus
    // scanning it - the same race the in-app updater retries around - so
    // try a few times before reporting failure. Callers that must not
    // stall (the installer window) run this on a worker thread.
    const ATTEMPTS: u32 = 5;
    for attempt in 1..=ATTEMPTS {
        if launch_app_once(exe, workdir) {
            log_str(&format!(
                "launch_app: {} -> started (attempt {attempt})",
                exe.display()
            ));
            return true;
        }
        log_str(&format!(
            "launch_app: attempt {attempt} of {ATTEMPTS} failed for {}",
            exe.display()
        ));
        if attempt < ATTEMPTS {
            std::thread::sleep(std::time::Duration::from_millis(600));
        }
    }
    log_str(&format!(
        "launch_app: {} -> FAILED after {ATTEMPTS} attempts",
        exe.display()
    ));
    false
}

fn launch_app_once(exe: &Path, workdir: &Path) -> bool {
    let exe_w = to_wide(&exe.to_string_lossy());
    let dir_w = to_wide(&workdir.to_string_lossy());
    let ok = unsafe {
        // ShellExecuteW first: it goes through the shell, so file associations
        // and the user's environment all apply.
        let verb = to_wide("open");
        let r = ShellExecuteW(
            None,
            PCWSTR(verb.as_ptr()),
            PCWSTR(exe_w.as_ptr()),
            None,
            PCWSTR(dir_w.as_ptr()),
            SW_SHOWNORMAL,
        );
        // ShellExecuteW returns a HINSTANCE > 32 on success.
        let mut ok = (r.0 as usize) > 32;
        if !ok {
            log_str(&format!(
                "launch_app: ShellExecuteW returned {} for {} - trying CreateProcessW",
                r.0 as isize,
                exe.display()
            ));
            // Fallback: create the process directly so a shell quirk can
            // never silently swallow the launch.
            let si = STARTUPINFOW {
                cb: std::mem::size_of::<STARTUPINFOW>() as u32,
                ..Default::default()
            };
            let mut pi = PROCESS_INFORMATION::default();
            ok = CreateProcessW(
                PCWSTR(exe_w.as_ptr()),
                None,
                None,
                None,
                false,
                Default::default(),
                None,
                PCWSTR(dir_w.as_ptr()),
                &si,
                &mut pi,
            )
            .is_ok();
            if ok {
                let _ = CloseHandle(pi.hProcess);
                let _ = CloseHandle(pi.hThread);
            }
        }
        ok
    };
    log_str(&format!(
        "launch_app: {} -> {}",
        exe.display(),
        if ok { "started" } else { "FAILED" }
    ));
    ok
}

/// Opens a URL in the user's default browser. Used for the "get a newer
/// version" escape hatch on the up-to-date screen - re-running an old
/// downloaded installer otherwise traps people on their old version.
pub fn open_url(url: &str) -> bool {
    unsafe {
        let r = ShellExecuteW(
            None,
            PCWSTR(to_wide("open").as_ptr()),
            PCWSTR(to_wide(url).as_ptr()),
            None,
            None,
            SW_SHOWNORMAL,
        );
        (r.0 as usize) > 32
    }
}
