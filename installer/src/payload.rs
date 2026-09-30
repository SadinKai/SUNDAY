// Self-extracting payload: a plain ZIP archive appended to the installer exe.
//
// Unsigned layout:  [ exe bytes ][ zip bytes ][ 8-byte magic ][ u64 zip start ]
// Signed layout:    [ same authenticated content ][ WIN_CERTIFICATE table ]
// The PE security directory identifies the certificate-table offset, so the
// trailer remains discoverable after Authenticode signing.
//
// The ZIP itself is produced by PowerShell's Compress-Archive (or any zip
// tool), so the parser tolerates both '/' and '\' entry separators, explicit
// directory entries and stored/deflate members.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

const TRAILER_MAGIC: &[u8; 8] = b"SUNDAYST";
const TRAILER_LEN: usize = 16;
const MAX_ARCHIVE_BYTES: usize = 512 * 1024 * 1024;
const MAX_ENTRIES: usize = 20_000;
const MAX_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const MAX_PATH_BYTES: usize = 512;
const MAX_COMPRESSION_RATIO: u64 = 250;
const INSTALL_MANIFEST: &str = "sunday-install-manifest.json";

pub struct Package {
    data: Vec<u8>,
}

pub struct Entry {
    pub name: String,
    pub method: u16,
    pub csize: u64,
    pub raw_size: u64,
    pub is_dir: bool,
    crc32: u32,
    local_header: u64,
}

pub struct Progress<'a> {
    pub done_bytes: u64,
    pub total_bytes: u64,
    pub file: &'a str,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InstallManifest {
    #[serde(rename = "schemaVersion")]
    schema_version: u32,
    product: String,
    version: String,
    files: Vec<VerifiedFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedFile {
    pub path: String,
    pub size: u64,
    pub sha256: String,
}

pub struct VerifiedManifest {
    pub files: Vec<VerifiedFile>,
}

impl Package {
    /// Cheap payload check: reads only the 16-byte trailer.
    pub fn exists() -> bool {
        let exe = match std::env::current_exe() {
            Ok(p) => p,
            Err(_) => return false,
        };
        let mut f = match fs::File::open(&exe) {
            Ok(f) => f,
            Err(_) => return false,
        };
        let len = match f.metadata() {
            Ok(m) => m.len(),
            Err(_) => return false,
        };
        let payload_end = payload_end(&mut f, len);
        if payload_end < TRAILER_LEN as u64 + 22 {
            return false;
        }
        if f.seek(SeekFrom::Start(payload_end - TRAILER_LEN as u64))
            .is_err()
        {
            return false;
        }
        let mut trailer = [0u8; TRAILER_LEN];
        if f.read_exact(&mut trailer).is_err() {
            return false;
        }
        if &trailer[0..8] != TRAILER_MAGIC {
            return false;
        }
        let start = u64::from_le_bytes(trailer[8..16].try_into().unwrap());
        start > 0 && start + TRAILER_LEN as u64 <= payload_end
    }

    /// Opens the payload from the running executable. Returns `None` when this
    /// copy carries no payload (e.g. the bare `uninstall.exe`).
    pub fn open() -> Option<Package> {
        let exe = std::env::current_exe().ok()?;
        let mut f = fs::File::open(&exe).ok()?;
        let file_len = f.metadata().ok()?.len();
        let payload_end = payload_end(&mut f, file_len) as usize;
        if payload_end < TRAILER_LEN + 22 {
            return None;
        }
        f.seek(SeekFrom::Start((payload_end - TRAILER_LEN) as u64))
            .ok()?;
        let mut trailer = [0u8; TRAILER_LEN];
        f.read_exact(&mut trailer).ok()?;
        if &trailer[0..8] != TRAILER_MAGIC {
            return None;
        }
        let start = u64::from_le_bytes(trailer[8..16].try_into().unwrap()) as usize;
        if start == 0 || start + TRAILER_LEN > payload_end {
            return None;
        }
        let zip_len = payload_end - TRAILER_LEN - start;
        if zip_len > MAX_ARCHIVE_BYTES {
            return None;
        }
        let mut data = vec![0u8; zip_len];
        f.seek(SeekFrom::Start(start as u64)).ok()?;
        f.read_exact(&mut data).ok()?;
        Some(Package { data })
    }

    fn eocd(&self) -> Option<usize> {
        // Scan backwards for the End Of Central Directory record.
        const SIG: [u8; 4] = [0x50, 0x4b, 0x05, 0x06];
        let max = self.data.len().checked_sub(22)?;
        let min = self.data.len().saturating_sub(22 + 65_535);
        let mut i = max;
        loop {
            if self.data[i..i + 4] == SIG && i + 20 <= self.data.len() {
                let comment_len =
                    u16::from_le_bytes([self.data[i + 20], self.data[i + 21]]) as usize;
                if i + 22 + comment_len == self.data.len() {
                    return Some(i);
                }
            }
            if i == min {
                return None;
            }
            i -= 1;
        }
    }

    pub fn entries(&self) -> Result<Vec<Entry>, String> {
        if self.data.len() > MAX_ARCHIVE_BYTES {
            return Err("payload: archive exceeds the size limit".into());
        }
        let eocd = self.eocd().ok_or("payload: no zip directory found")?;
        let d = &self.data;
        let rd16 = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
        let rd32 = |o: usize| u32::from_le_bytes([d[o], d[o + 1], d[o + 2], d[o + 3]]) as usize;

        let count = rd16(eocd + 10);
        if count > MAX_ENTRIES {
            return Err("payload: too many entries".into());
        }
        let cd_size = rd32(eocd + 12);
        let cd_off = rd32(eocd + 16);
        let cd_end = cd_off
            .checked_add(cd_size)
            .ok_or("payload: zip directory overflow")?;
        if cd_end > self.data.len() {
            return Err("payload: zip directory out of range".into());
        }

        let mut out = Vec::with_capacity(count);
        let mut names = HashSet::with_capacity(count);
        let mut total_raw = 0u64;
        let mut p = cd_off;
        for _ in 0..count {
            if p + 46 > d.len() || d[p..p + 4] != [0x50, 0x4b, 0x01, 0x02] {
                return Err("payload: corrupt zip directory".into());
            }
            let method = rd16(p + 10) as u16;
            let crc32 = rd32(p + 16) as u32;
            let csize = rd32(p + 20) as u64;
            let raw_size = rd32(p + 24) as u64;
            let name_len = rd16(p + 28);
            let extra_len = rd16(p + 30);
            let comment_len = rd16(p + 32);
            let ext_attr = rd32(p + 38);
            let lho = rd32(p + 42) as u64;
            let record_end = p
                .checked_add(46)
                .and_then(|v| v.checked_add(name_len))
                .and_then(|v| v.checked_add(extra_len))
                .and_then(|v| v.checked_add(comment_len))
                .ok_or("payload: zip directory overflow")?;
            if record_end > d.len() || record_end > cd_off + cd_size {
                return Err("payload: corrupt zip directory bounds".into());
            }
            if csize == 0xFFFF_FFFF || raw_size == 0xFFFF_FFFF {
                return Err("payload: zip64 archives are not supported".into());
            }
            let name_bytes = &d[p + 46..p + 46 + name_len];
            let mut name = std::str::from_utf8(name_bytes)
                .map_err(|_| "payload: entry name is not valid UTF-8")?
                .to_string();
            name = name.replace('\\', "/");
            let is_dir = name.ends_with('/') || (raw_size == 0 && (ext_attr & 0x10) != 0);
            if name.is_empty() {
                return Err("payload: empty entry name".into());
            }
            if name.len() > MAX_PATH_BYTES || raw_size > MAX_ENTRY_BYTES {
                return Err(format!("payload: entry exceeds a configured limit: {name}"));
            }
            if csize > 0 && raw_size / csize.max(1) > MAX_COMPRESSION_RATIO {
                return Err(format!("payload: suspicious compression ratio: {name}"));
            }
            total_raw = total_raw
                .checked_add(raw_size)
                .ok_or("payload: total size overflow")?;
            if total_raw > MAX_TOTAL_BYTES {
                return Err("payload: expanded content exceeds the size limit".into());
            }
            let normalized_name = validate_entry_name(&name, is_dir)?;
            if !names.insert(normalized_name) {
                return Err(format!("payload: duplicate entry path: {name}"));
            }
            out.push(Entry {
                name,
                method,
                csize,
                raw_size,
                is_dir,
                crc32,
                local_header: lho,
            });
            p = record_end;
        }
        Ok(out)
    }

    fn entry_bytes(&self, e: &Entry) -> Result<Vec<u8>, String> {
        let d = &self.data;
        let lho = e.local_header as usize;
        let header_end = lho
            .checked_add(30)
            .ok_or("payload: zip entry header overflow")?;
        if header_end > d.len() || d[lho..lho + 4] != [0x50, 0x4b, 0x03, 0x04] {
            return Err("payload: corrupt zip entry header".into());
        }
        let name_len = u16::from_le_bytes([d[lho + 26], d[lho + 27]]) as usize;
        let extra_len = u16::from_le_bytes([d[lho + 28], d[lho + 29]]) as usize;
        let start = header_end
            .checked_add(name_len)
            .and_then(|v| v.checked_add(extra_len))
            .ok_or("payload: zip entry offset overflow")?;
        let end = start
            .checked_add(e.csize as usize)
            .ok_or("payload: zip entry size overflow")?;
        if end > d.len() {
            return Err("payload: truncated zip entry".into());
        }
        let raw = &d[start..end];
        let output = match e.method {
            0 if raw.len() as u64 == e.raw_size => Ok(raw.to_vec()),
            0 => Err(format!("payload: stored entry size mismatch: {}", e.name)),
            8 => {
                let limit = e.raw_size as usize;
                miniz_oxide::inflate::decompress_to_vec_with_limit(raw, limit)
                    .map_err(|_| format!("payload: could not decompress {}", e.name))
            }
            m => Err(format!("payload: unsupported compression method {m}")),
        }?;
        if output.len() as u64 != e.raw_size {
            return Err(format!("payload: expanded entry size mismatch: {}", e.name));
        }
        if crc32(&output) != e.crc32 {
            return Err(format!("payload: CRC mismatch: {}", e.name));
        }
        Ok(output)
    }

    /// Extracts everything into `dest`. Every file - including the optional
    /// WebView2 bootstrapper - lands in the destination folder; nothing is ever
    /// written to or executed from the temp directory (a classic dropper
    /// heuristic antivirus engines score heavily).
    pub fn extract(
        &self,
        entries: &[Entry],
        dest: &Path,
        mut progress: impl FnMut(Progress),
    ) -> Result<(), String> {
        ensure_plain_directory(dest)?;
        let total: u64 = entries.iter().map(|e| e.raw_size).sum();
        let mut done: u64 = 0;

        for e in entries {
            if e.is_dir {
                let dir = safe_join(dest, &e.name)?;
                fs::create_dir_all(&dir)
                    .map_err(|err| format!("could not create folder {}\n{}", dir.display(), err))?;
                ensure_plain_directory(&dir)?;
                continue;
            }
            let data = self.entry_bytes(e)?;
            let target = safe_join(dest, &e.name)?;
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent).map_err(|err| {
                    format!("could not create folder {}\n{}", parent.display(), err)
                })?;
                ensure_plain_directory(parent)?;
            }
            let mut output = fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|err| format!("could not create {}\n{}", target.display(), err))?;
            output
                .write_all(&data)
                .map_err(|err| format!("could not write {}\n{}", target.display(), err))?;
            output
                .sync_all()
                .map_err(|err| format!("could not flush {}\n{}", target.display(), err))?;
            done += e.raw_size;
            progress(Progress {
                done_bytes: done,
                total_bytes: total,
                file: &e.name,
            });
        }
        Ok(())
    }

    /// The signed archive must carry a closed-world file manifest. Every
    /// extracted file (other than the manifest itself) is size/hash checked,
    /// every manifest path must exist, and undeclared archive content fails.
    pub fn verify_install_manifest(
        &self,
        entries: &[Entry],
        dest: &Path,
        expected_version: &str,
    ) -> Result<VerifiedManifest, String> {
        let manifest_entry = entries
            .iter()
            .find(|entry| !entry.is_dir && entry.name.eq_ignore_ascii_case(INSTALL_MANIFEST))
            .ok_or("payload: install manifest is missing")?;
        let manifest_bytes = self.entry_bytes(manifest_entry)?;
        let manifest: InstallManifest = serde_json::from_slice(&manifest_bytes)
            .map_err(|err| format!("payload: install manifest is invalid: {err}"))?;
        verify_manifest_document(&manifest, entries, dest, expected_version)?;
        let mut files = manifest.files;
        files.push(VerifiedFile {
            path: INSTALL_MANIFEST.into(),
            size: manifest_bytes.len() as u64,
            sha256: format!("{:x}", Sha256::digest(&manifest_bytes)),
        });
        Ok(VerifiedManifest { files })
    }
}

fn verify_manifest_document(
    manifest: &InstallManifest,
    entries: &[Entry],
    dest: &Path,
    expected_version: &str,
) -> Result<(), String> {
    if manifest.schema_version != 1 || manifest.product != "SUNDAY Launcher" {
        return Err("payload: install manifest identity is invalid".into());
    }
    if manifest.version != expected_version {
        return Err("payload: install manifest version does not match the installer".into());
    }
    let mut declared = HashSet::with_capacity(manifest.files.len());
    for item in &manifest.files {
        let normalized = validate_entry_name(&item.path.replace('\\', "/"), false)?;
        if normalized == INSTALL_MANIFEST {
            return Err("payload: install manifest must not declare itself".into());
        }
        if !declared.insert(normalized.clone()) {
            return Err(format!("payload: duplicate manifest path: {}", item.path));
        }
        if item.sha256.len() != 64
            || !item
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(format!("payload: invalid SHA-256 for {}", item.path));
        }
        let target = safe_join(dest, &item.path.replace('\\', "/"))?;
        let meta = fs::symlink_metadata(&target)
            .map_err(|_| format!("payload: manifest file is missing: {}", item.path))?;
        if !meta.is_file() || meta.file_type().is_symlink() || meta.len() != item.size {
            return Err(format!(
                "payload: manifest size/type mismatch: {}",
                item.path
            ));
        }
        let bytes = fs::read(&target)
            .map_err(|err| format!("payload: could not verify {}: {err}", item.path))?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != item.sha256 {
            return Err(format!("payload: manifest hash mismatch: {}", item.path));
        }
    }

    let mut archive_files = HashSet::new();
    for entry in entries.iter().filter(|entry| !entry.is_dir) {
        let normalized = validate_entry_name(&entry.name, false)?;
        if normalized != INSTALL_MANIFEST {
            archive_files.insert(normalized);
        }
    }
    if archive_files != declared {
        return Err("payload: archive and install manifest file sets differ".into());
    }
    for required in ["sunday.exe", "node.exe", "uninstall.exe"] {
        if !declared.contains(required) {
            return Err(format!(
                "payload: required file is not declared: {required}"
            ));
        }
    }
    Ok(())
}

/// Authenticode stores its WIN_CERTIFICATE table after the hashed PE content.
/// The security data-directory VirtualAddress is a file offset (unlike other
/// PE directories), so it is the signed payload boundary when present.
fn payload_end(file: &mut fs::File, file_len: u64) -> u64 {
    let mut dos = [0u8; 64];
    if file.seek(SeekFrom::Start(0)).is_err() || file.read_exact(&mut dos).is_err() {
        return file_len;
    }
    if &dos[0..2] != b"MZ" {
        return file_len;
    }
    let pe_offset = u32::from_le_bytes(dos[0x3c..0x40].try_into().unwrap()) as u64;
    let Some(coff_end) = pe_offset.checked_add(24) else {
        return file_len;
    };
    if coff_end > file_len {
        return file_len;
    }
    let mut coff = [0u8; 24];
    if file.seek(SeekFrom::Start(pe_offset)).is_err() || file.read_exact(&mut coff).is_err() {
        return file_len;
    }
    if &coff[0..4] != b"PE\0\0" {
        return file_len;
    }
    let optional_size = u16::from_le_bytes([coff[20], coff[21]]) as usize;
    if !(136..=4096).contains(&optional_size) {
        return file_len;
    }
    let mut optional = vec![0u8; optional_size];
    if file.read_exact(&mut optional).is_err() {
        return file_len;
    }
    let magic = u16::from_le_bytes([optional[0], optional[1]]);
    let security_offset = match magic {
        0x10b => 128usize,
        0x20b => 144usize,
        _ => return file_len,
    };
    if security_offset + 8 > optional.len() {
        return file_len;
    }
    let certificate_offset = u32::from_le_bytes(
        optional[security_offset..security_offset + 4]
            .try_into()
            .unwrap(),
    ) as u64;
    let certificate_size = u32::from_le_bytes(
        optional[security_offset + 4..security_offset + 8]
            .try_into()
            .unwrap(),
    ) as u64;
    let Some(certificate_end) = certificate_offset.checked_add(certificate_size) else {
        return file_len;
    };
    if certificate_offset >= TRAILER_LEN as u64
        && certificate_size >= 8
        && certificate_end <= file_len
    {
        certificate_offset
    } else {
        file_len
    }
}

pub fn ensure_plain_directory(dir: &Path) -> Result<(), String> {
    for ancestor in dir.ancestors() {
        let meta = match fs::symlink_metadata(ancestor) {
            Ok(meta) => meta,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => continue,
            Err(err) => return Err(format!("could not inspect {}\n{err}", ancestor.display())),
        };
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
            if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                return Err(format!(
                    "refusing reparse-point extraction path: {}",
                    ancestor.display()
                ));
            }
        }
        if ancestor == dir && !meta.is_dir() {
            return Err(format!(
                "refusing non-directory extraction path: {}",
                dir.display()
            ));
        }
    }
    Ok(())
}

fn safe_join(root: &Path, name: &str) -> Result<PathBuf, String> {
    let _ = validate_entry_name(name, name.ends_with('/'))?;
    let mut path = root.to_path_buf();
    for part in name.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err(format!("unsafe path in payload: {name}")),
            p if p.contains(':') => return Err(format!("unsafe path in payload: {name}")),
            p => {
                path.push(p);
            }
        }
    }
    Ok(path)
}

fn validate_entry_name(name: &str, is_dir: bool) -> Result<String, String> {
    if name.is_empty()
        || name.starts_with('/')
        || name.starts_with("//")
        || !name.is_ascii()
        || name.as_bytes().contains(&0)
    {
        return Err(format!("unsafe path in payload: {name}"));
    }
    let body = if is_dir {
        name.strip_suffix('/').unwrap_or(name)
    } else {
        name
    };
    if body.is_empty() || body.contains("//") {
        return Err(format!("unsafe path in payload: {name}"));
    }
    let mut normalized = Vec::new();
    for part in body.split('/') {
        if part == "."
            || part == ".."
            || part.contains(':')
            || part.ends_with('.')
            || part.ends_with(' ')
            || part.chars().any(|c| c.is_control())
        {
            return Err(format!("unsafe path in payload: {name}"));
        }
        let base = part.split('.').next().unwrap_or("").to_ascii_uppercase();
        let reserved = matches!(base.as_str(), "CON" | "PRN" | "AUX" | "NUL" | "CLOCK$")
            || (base.len() == 4
                && (base.starts_with("COM") || base.starts_with("LPT"))
                && matches!(base.as_bytes()[3], b'1'..=b'9'));
        if reserved {
            return Err(format!("reserved Windows device name in payload: {name}"));
        }
        normalized.push(part.to_ascii_lowercase());
    }
    if normalized.is_empty() {
        return Err(format!("unsafe path in payload: {name}"));
    }
    Ok(normalized.join("/"))
}

fn crc32(bytes: &[u8]) -> u32 {
    let mut crc = 0xffff_ffffu32;
    for byte in bytes {
        crc ^= u32::from(*byte);
        for _ in 0..8 {
            let mask = 0u32.wrapping_sub(crc & 1);
            crc = (crc >> 1) ^ (0xedb8_8320 & mask);
        }
    }
    !crc
}

/// Appends `zip_path` to `exe_path`, producing the final self-extracting
/// installer at `out_path`. (Used by the build pipeline; also handy for tests.)
#[allow(dead_code)]
pub fn attach(exe_path: &Path, zip_path: &Path, out_path: &Path) -> Result<(), String> {
    let mut exe = fs::read(exe_path).map_err(|e| e.to_string())?;
    let zip = fs::read(zip_path).map_err(|e| e.to_string())?;
    let start = exe.len() as u64;
    exe.extend_from_slice(&zip);
    exe.extend_from_slice(TRAILER_MAGIC);
    exe.extend_from_slice(&start.to_le_bytes());
    fs::write(out_path, exe).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{
        crc32, payload_end, validate_entry_name, verify_manifest_document, Entry, InstallManifest,
        VerifiedFile,
    };
    use sha2::{Digest, Sha256};
    use std::io::Write;

    #[test]
    fn windows_paths_are_normalized_or_rejected() {
        assert_eq!(
            validate_entry_name("Sunday/App.js", false).unwrap(),
            "sunday/app.js"
        );
        for unsafe_name in [
            "/absolute.exe",
            "//server/share.exe",
            "../escape.exe",
            "dir/../escape.exe",
            "C:/drive.exe",
            "dir//double.exe",
            "dir/trailing. ",
            "CON",
            "aux.txt",
            "COM1.dll",
            "unicode-ß.txt",
        ] {
            assert!(
                validate_entry_name(unsafe_name, false).is_err(),
                "accepted {unsafe_name}"
            );
        }
    }

    #[test]
    fn crc32_matches_zip_reference_vector() {
        assert_eq!(crc32(b"123456789"), 0xcbf4_3926);
    }

    #[test]
    fn authenticode_certificate_offset_is_the_payload_boundary() {
        let mut bytes = vec![0u8; 512];
        bytes[0..2].copy_from_slice(b"MZ");
        bytes[0x3c..0x40].copy_from_slice(&0x80u32.to_le_bytes());
        bytes[0x80..0x84].copy_from_slice(b"PE\0\0");
        bytes[0x94..0x96].copy_from_slice(&0xf0u16.to_le_bytes());
        let optional = 0x98usize;
        bytes[optional..optional + 2].copy_from_slice(&0x20bu16.to_le_bytes());
        bytes[optional + 144..optional + 148].copy_from_slice(&400u32.to_le_bytes());
        bytes[optional + 148..optional + 152].copy_from_slice(&64u32.to_le_bytes());

        let path = std::env::temp_dir().join(format!(
            "sunday-payload-boundary-{}-{}.exe",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut output = std::fs::File::create(&path).unwrap();
        output.write_all(&bytes).unwrap();
        output.sync_all().unwrap();
        drop(output);
        let mut input = std::fs::File::open(&path).unwrap();
        assert_eq!(payload_end(&mut input, bytes.len() as u64), 400);
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn install_manifest_is_closed_world_and_hash_verified() {
        let root = std::env::temp_dir().join(format!(
            "sunday-manifest-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir(&root).unwrap();
        let names = ["Sunday.exe", "node.exe", "uninstall.exe"];
        let mut files = Vec::new();
        let mut entries = Vec::new();
        for name in names {
            let bytes = format!("content:{name}").into_bytes();
            std::fs::write(root.join(name), &bytes).unwrap();
            files.push(VerifiedFile {
                path: name.into(),
                size: bytes.len() as u64,
                sha256: format!("{:x}", Sha256::digest(&bytes)),
            });
            entries.push(Entry {
                name: name.into(),
                method: 0,
                csize: bytes.len() as u64,
                raw_size: bytes.len() as u64,
                is_dir: false,
                crc32: 0,
                local_header: 0,
            });
        }
        entries.push(Entry {
            name: "sunday-install-manifest.json".into(),
            method: 0,
            csize: 1,
            raw_size: 1,
            is_dir: false,
            crc32: 0,
            local_header: 0,
        });
        let mut manifest = InstallManifest {
            schema_version: 1,
            product: "SUNDAY Launcher".into(),
            version: "1.8.14".into(),
            files,
        };
        verify_manifest_document(&manifest, &entries, &root, "1.8.14").unwrap();
        manifest.files[0].sha256 = "0".repeat(64);
        assert!(
            verify_manifest_document(&manifest, &entries, &root, "1.8.14")
                .unwrap_err()
                .contains("hash mismatch")
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
