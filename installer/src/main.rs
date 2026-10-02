// SUNDAY Launcher installer - a borderless window rendered entirely by SUNDAY Launcher.
//
// The whole surface - shape, corners, text, buttons, progress - is drawn by
// GDI+ into a 32-bit premultiplied-alpha bitmap and pushed with
// UpdateLayeredWindow. The corners are rounded by our own anti-aliased mask,
// so they look the same on every Windows version (10 included). No native
// caption, no wizard controls, no message boxes: the only external window is
// the OS folder picker.
//
// Flow (fresh):     new empty folder -> Install SUNDAY Launcher -> progress -> done.
// Existing install: explain that in-place update is unavailable -> Close.
// Canonical uninstaller: verify registry + ledger + release identity -> exact removal.

#![cfg_attr(not(feature = "console"), windows_subsystem = "windows")]
#![allow(clippy::too_many_arguments)]

mod ledger;
mod legacy_identity;
mod payload;
mod shell;

use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::mpsc::{channel, Receiver, Sender};

use windows::core::{w, GUID, PCWSTR};
use windows::Win32::Foundation::{
    CloseHandle, COLORREF, HGLOBAL, HINSTANCE, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM,
};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC, ScreenToClient,
    SelectObject, AC_SRC_ALPHA, AC_SRC_OVER, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, BLENDFUNCTION,
    DIB_RGB_COLORS, HBITMAP, HDC, HGDIOBJ, LOGFONTW,
};
use windows::Win32::Graphics::GdiPlus::{
    CombineModeReplace, FillModeAlternate, FlushIntentionFlush, GdipAddPathArc,
    GdipClosePathFigures, GdipCreateBitmapFromScan0, GdipCreateFontFromLogfontW, GdipCreatePath,
    GdipCreatePen1, GdipCreateSolidFill, GdipCreateStringFormat, GdipDeleteBrush, GdipDeleteFont,
    GdipDeleteGraphics, GdipDeletePath, GdipDeletePen, GdipDeleteStringFormat, GdipDisposeImage,
    GdipDrawLine, GdipDrawPath, GdipDrawString, GdipFillPath, GdipFillRectangleI, GdipFlush,
    GdipGetImageGraphicsContext, GdipGraphicsClear, GdipMeasureString, GdipResetClip,
    GdipSetClipPath, GdipSetSmoothingMode, GdipSetStringFormatAlign, GdipSetStringFormatFlags,
    GdipSetStringFormatLineAlign, GdipSetStringFormatTrimming, GdipSetTextRenderingHint,
    GdiplusStartup, GdiplusStartupInput, GpBitmap, GpBrush, GpFont, GpGraphics, GpImage, GpPath,
    GpPen, GpSolidFill, GpStringFormat, RectF, SmoothingModeAntiAlias, Status,
    StringAlignmentCenter, StringAlignmentFar, StringAlignmentNear, StringFormatFlagsNoWrap,
    StringTrimmingEllipsisCharacter, TextRenderingHintAntiAliasGridFit, UnitPixel,
};
use windows::Win32::Storage::FileSystem::{MoveFileExW, MOVEFILE_DELAY_UNTIL_REBOOT};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_APARTMENTTHREADED};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, OpenClipboard};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Memory::{GlobalLock, GlobalUnlock};
use windows::Win32::System::SystemInformation::GetTickCount64;
use windows::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};
use windows::Win32::UI::HiDpi::{
    GetDpiForWindow, SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetKeyState, VK_CONTROL, VK_ESCAPE, VK_RETURN, VK_SPACE, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetCursorPos, GetMessageW,
    GetWindowLongPtrW, GetWindowRect, KillTimer, LoadCursorW, LoadIconW, PostMessageW,
    PostQuitMessage, RegisterClassW, SetTimer, SetWindowLongPtrW, SetWindowPos, ShowWindow,
    SystemParametersInfoW, TranslateMessage, UpdateLayeredWindow, CW_USEDEFAULT, GWLP_USERDATA,
    HTCAPTION, HTCLIENT, HWND_TOP, IDC_ARROW, IDI_APPLICATION, MSG, SPI_GETWORKAREA,
    SWP_NOACTIVATE, SWP_NOZORDER, SW_SHOW, ULW_ALPHA, WM_CHAR, WM_CLOSE, WM_DPICHANGED,
    WM_ERASEBKGND, WM_KEYDOWN, WM_LBUTTONDOWN, WM_LBUTTONUP, WM_MOUSEMOVE, WM_NCCREATE,
    WM_NCDESTROY, WM_NCHITTEST, WM_NCLBUTTONDBLCLK, WM_TIMER, WNDCLASSW, WS_EX_LAYERED, WS_POPUP,
};

use ledger::{AuthenticodeEvidence, PRODUCT_GUID};
use payload::{ensure_plain_directory, Package};
use shell::{to_wide, CSIDL_DESKTOPDIRECTORY, CSIDL_PROGRAMS};

// ------------------------------------------------------------------ branding

const SUNDAY_VERSION: &str = env!("SUNDAY_VERSION");
const SUNDAY_RELEASE_PUBLISHER: &str = env!("SUNDAY_RELEASE_PUBLISHER");
const UNSIGNED_RELEASE_IDENTITY: &str = "SUNDAY unsigned SHA-256 release";
const APP_TITLE: &str = "SUNDAY Launcher";
const UNINSTALL_TITLE: &str = "SUNDAY Launcher - Uninstall";
const CURRENT_MAIN_BINARY: &str = "Sunday.exe";

fn release_identity(embedded_publisher: &str) -> &str {
    if embedded_publisher.trim().is_empty() {
        UNSIGNED_RELEASE_IDENTITY
    } else {
        embedded_publisher
    }
}

fn release_is_signed() -> bool {
    !SUNDAY_RELEASE_PUBLISHER.trim().is_empty()
}

#[cfg(test)]
mod release_mode_tests {
    use super::{release_identity, UNSIGNED_RELEASE_IDENTITY};

    #[test]
    fn empty_publisher_selects_explicit_unsigned_integrity_identity() {
        assert_eq!(release_identity(""), UNSIGNED_RELEASE_IDENTITY);
        assert_eq!(release_identity("  "), UNSIGNED_RELEASE_IDENTITY);
    }

    #[test]
    fn configured_publisher_preserves_signed_release_identity() {
        assert_eq!(
            release_identity("CN=SUNDAY Production"),
            "CN=SUNDAY Production"
        );
    }
}

// SUNDAY Launcher's palette (COLORREF is 0x00BBGGRR).
const BG: u32 = 0x0013_0F0E; // #0e0f13 window
const INK: u32 = 0x00F1_F0F4; // #f4f0f1 primary text
const INK_2: u32 = 0x00A7_A3AA; // #aaa3a7 secondary text
const INK_3: u32 = 0x0071_6C72; // #726c71 muted text
const HAIR: u32 = 0x002E_2626; // #26262e hairlines
const TRACK: u32 = 0x0034_2D2C; // #2c2d34 progress track
const ACCENT: u32 = 0x00F6_823B; // #3b82f6 SUNDAY blue
const DANGER: u32 = 0x00AC_9BFF; // #ff9bac error text

// Buttons (match the app's .btn styles).
const SURFACE: u32 = 0x0020_1A1A;
const SURFACE_2: u32 = 0x0027_2020;
const SURFACE_3: u32 = 0x0030_2727;
const HAIR_2: u32 = 0x0047_3D3D;
const ON_INK: u32 = 0x00FF_FBF8;
const PRIM: u32 = 0x00EB_6325;
const PRIM_DOWN: u32 = 0x00CE_5720;
const PRIM_OFF: u32 = 0x0069_3117;
const PRIM_OFF_TX: u32 = 0x00A5_8171;
const SEC_OFF: u32 = 0x0018_1313;
const DANGER_RING: u32 = 0x0035_266E;
const DANGER_EDGE: u32 = 0x0059_42DC;
const DANGER_HOT: u32 = 0x001D_1632;
const DANGER_DOWN: u32 = 0x0019_132A;
/// Secondary controls lift their border on hover (the app's .btn:hover mix).
const HAIR_HOT: u32 = 0x0061_595C; // #5c5961
/// The input focus halo: accent at 26% alpha (the app's input box-shadow).
/// Raw ARGB, not a COLORREF - it is passed straight to GDI+.
const HALO_ARGB: u32 = 0x423B_82F6;

// Caption close button (matches the app's window controls).
const CLOSE_HOT: u32 = 0x001C_2BC4; // #c42b1c
const CLOSE_DOWN: u32 = 0x001D_27A4; // #a4271d

/// Corner radius in logical pixels. The window is 8px like the app's large
/// surfaces; controls use the app's 6px control radius.
const WIN_RADIUS: f32 = 8.0;
const BTN_RADIUS: f32 = 6.0;

// Timers
const IDT_FADE: usize = 1;
#[cfg(debug_assertions)]
const IDT_DEMO: usize = 3;
const IDT_POLL: usize = 4;
const IDT_CARET: usize = 7;
const IDT_HOVER: usize = 8;

// Widget ids.
const IDC_HEAD: i32 = 1;
const IDC_SUB: i32 = 2;
const IDC_HINT: i32 = 4;
const IDC_ERROR: i32 = 5;
const IDC_BYTES: i32 = 6;
const IDC_FILE: i32 = 7;
const IDC_LABEL: i32 = 10;
const IDC_RULE: i32 = 11;

const IDC_PATHEDIT: i32 = 120;
const IDC_BROWSE: i32 = 101;
const IDC_INSTALL: i32 = 103;
const IDC_LAUNCH: i32 = 105;
const IDC_CLOSE: i32 = 106;
const IDC_CHECK_DESKTOP: i32 = 107;
const IDC_RETRY: i32 = 113;
const IDC_RELEASES: i32 = 114;
const IDC_CANCEL: i32 = 2;
const IDC_CAPCLOSE: i32 = 901; // caption close button

// Window metrics (logical pixels at 96 DPI).
const WIN_W: i32 = 520;
const WIN_H: i32 = 376;
const CLOSE_W: i32 = 46;
const CLOSE_H: i32 = 32;

// 32bpp premultiplied ARGB (GDI+ PixelFormat32bppPARGB).
const PF_PARGB: i32 = 0x000E_200B;

// ------------------------------------------------------------------ state

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Stage {
    Fresh,
    UpToDate,
    Installing,
    Done,
    Error,
    UninstallConfirm,
}

enum Msg {
    File(String),
    Bytes(u64, u64),
    Note(String),
    /// Outcome of the worker thread's post-install launch of SUNDAY Launcher.
    Relaunched(bool),
    RemovalReady,
    Done,
    Err(String),
}

struct Fonts {
    display: *mut GpFont,
    head: *mut GpFont,
    /// 500-weight control text, the app's .btn label weight.
    label: *mut GpFont,
    body: *mut GpFont,
    path: *mut GpFont,
    small: *mut GpFont,
}

enum After {
    None,
    Quit,
}

struct Fade {
    active: bool,
    from: u8,
    to: u8,
    t0: u64,
    dur: u32,
    after: After,
}

/// The layered-window canvas: a 32-bit DIB wrapped by GDI+, presented with
/// UpdateLayeredWindow. The alpha channel is the window's shape.
struct Canvas {
    w: i32,
    h: i32,
    dc: HDC,
    bmp: HBITMAP,
    old: HGDIOBJ,
    gfx: *mut GpGraphics,
    image: *mut GpBitmap,
}

#[derive(Clone, Copy)]
enum Align {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy)]
enum FontRole {
    Head,
    Label,
    Body,
    Small,
}

/// One drawn element. Widgets are plain data: rendering, hit-testing and
/// keyboard focus all walk this list.
struct Wg {
    id: i32,
    kind: WgKind,
    /// Logical-pixel rect (scaled at draw time).
    x: f32,
    y: f32,
    w: f32,
    h: f32,
}

enum WgKind {
    Button {
        label: String,
        primary: bool,
        danger: bool,
        enabled: bool,
    },
    Check {
        label: String,
        checked: bool,
    },
    PathField,
    Text {
        text: String,
        ink: u32,
        align: Align,
        font: FontRole,
        wrap: bool,
        /// Top-align instead of vertically centering (multi-line blocks).
        top: bool,
    },
    Rule,
    Progress,
    CloseBtn,
}

struct App {
    hwnd: HWND,
    canvas: Option<Canvas>,
    fonts: Fonts,
    scale: f32,
    uninstall_mode: bool,
    #[cfg(debug_assertions)]
    demo: bool,
    stage: Stage,
    widgets: Vec<Wg>,
    /// Widget under the mouse.
    hot: Option<i32>,
    /// Widget with the button held down.
    pressed: Option<i32>,
    /// Widget with keyboard focus.
    focus: Option<i32>,
    caret_on: bool,
    alpha: u8,
    progress: f32,
    path: String,
    desktop_shortcut: bool,
    last_error: String,
    install_dest: PathBuf,
    rx: Option<Receiver<Msg>>,
    busy: bool,
    fade: Fade,
    installed: Option<(PathBuf, String)>,
    /// Outcome of the worker's post-install launch (None: not attempted).
    relaunch_ok: Option<bool>,
}

// ------------------------------------------------------------------ helpers

#[cfg(debug_assertions)]
fn debug_log(s: &str) {
    if std::env::var_os("SUNDAY_SETUP_LOG").is_some() {
        let line = format!("[sunday-setup] {s}\r\n");
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
fn debug_log(_: &str) {}

fn should_launch_after_install(app: &App) -> bool {
    #[cfg(debug_assertions)]
    {
        !app.demo
    }
    #[cfg(not(debug_assertions))]
    {
        let _ = app;
        true
    }
}

fn mb(bytes: u64) -> String {
    format!("{:.1} MB", bytes as f64 / 1_048_576.0)
}

/// Compares dotted versions ("1.5.12" vs "1.6"); non-numeric parts are 0.
fn version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let nums = |s: &str| -> Vec<u64> {
        s.split('.')
            .map(|p| p.trim().parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (a, b) = (nums(a), nums(b));
    for i in 0..a.len().max(b.len()) {
        let x = a.get(i).copied().unwrap_or(0);
        let y = b.get(i).copied().unwrap_or(0);
        match x.cmp(&y) {
            std::cmp::Ordering::Equal => continue,
            o => return o,
        }
    }
    std::cmp::Ordering::Equal
}

/// Validates a typed/chosen install folder. Returns the cleaned path.
fn validate_path(raw: &str) -> Result<String, &'static str> {
    let t = raw.trim().trim_matches('"').trim();
    if t.is_empty() {
        return Err("Enter a folder path, such as C:\\Apps\\SUNDAY Launcher.");
    }
    let unc = t.starts_with("\\\\");
    if !unc {
        let b = t.as_bytes();
        if b.len() < 3 || !b[0].is_ascii_alphabetic() || b[1] != b':' || b[2] != b'\\' {
            return Err("Enter a full path starting with a drive letter, such as C:\\Apps\\SUNDAY Launcher.");
        }
        if b.len() == 3 {
            return Err("Choose a folder, not an entire drive.");
        }
    }
    let body = if unc { &t[2..] } else { &t[3..] };
    if body.contains(':') {
        return Err("That character is not allowed in a folder path.");
    }
    for ch in ['<', '>', '|', '?', '*'] {
        if body.contains(ch) {
            return Err("That character is not allowed in a folder path.");
        }
    }
    let mut cleaned = t.to_string();
    while cleaned.len() > 3 && cleaned.ends_with('\\') {
        cleaned.pop();
    }
    Ok(cleaned)
}

/// COLORREF (0x00BBGGRR) -> GDI+ ARGB (0xAARRGGBB).
fn argb(c: u32) -> u32 {
    0xFF00_0000 | ((c & 0x0000_00FF) << 16) | (c & 0x0000_FF00) | ((c & 0x00FF_0000) >> 16)
}

/// GDI+ font from a logical-font spec. Creation goes through the GDI font
/// mapper, so missing faces (Segoe UI Variable on older Windows) substitute
/// cleanly instead of falling back to a default serif.
unsafe fn make_font(
    face: &str,
    weight: i32,
    logical_height: i32,
    scale: f32,
    screen: HDC,
) -> *mut GpFont {
    let mut lf = LOGFONTW {
        lfHeight: -((logical_height as f32 * scale).round() as i32),
        lfWeight: weight,
        lfCharSet: windows::Win32::Graphics::Gdi::FONT_CHARSET(1), // DEFAULT_CHARSET
        lfOutPrecision: windows::Win32::Graphics::Gdi::FONT_OUTPUT_PRECISION(0),
        lfClipPrecision: windows::Win32::Graphics::Gdi::FONT_CLIP_PRECISION(0),
        lfQuality: windows::Win32::Graphics::Gdi::FONT_QUALITY(5), // CLEARTYPE_QUALITY
        lfPitchAndFamily: 0x22,                                    // VARIABLE_PITCH | FF_SWISS
        ..Default::default()
    };
    let wide: Vec<u16> = face.encode_utf16().chain(std::iter::once(0)).collect();
    let n = wide.len().min(31);
    lf.lfFaceName[..n].copy_from_slice(&wide[..n]);
    let mut font: *mut GpFont = std::ptr::null_mut();
    GdipCreateFontFromLogfontW(screen, &lf, &mut font);
    font
}

unsafe fn delete_fonts(f: &Fonts) {
    GdipDeleteFont(f.display);
    GdipDeleteFont(f.head);
    GdipDeleteFont(f.label);
    GdipDeleteFont(f.body);
    GdipDeleteFont(f.path);
    GdipDeleteFont(f.small);
}

unsafe fn build_fonts(scale: f32) -> Fonts {
    let screen = GetDC(None);
    let fonts = Fonts {
        display: make_font("Segoe UI Variable Display", 600, 24, scale, screen),
        head: make_font("Segoe UI Variable Display", 600, 17, scale, screen),
        label: make_font("Segoe UI Variable Text", 500, 13, scale, screen),
        body: make_font("Segoe UI Variable Text", 400, 13, scale, screen),
        path: make_font("Segoe UI Variable Text", 400, 14, scale, screen),
        small: make_font("Segoe UI Variable Text", 400, 12, scale, screen),
    };
    ReleaseDC(None, screen);
    fonts
}

// ------------------------------------------------------------------ canvas

unsafe fn canvas_create(w: i32, h: i32) -> Option<Canvas> {
    if w <= 0 || h <= 0 {
        return None;
    }
    let dc = CreateCompatibleDC(None);
    if dc.0.is_null() {
        return None;
    }
    let bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w,
            biHeight: -h, // top-down rows
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            biSizeImage: 0,
            biXPelsPerMeter: 0,
            biYPelsPerMeter: 0,
            biClrUsed: 0,
            biClrImportant: 0,
        },
        bmiColors: Default::default(),
    };
    let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
    let bmp = CreateDIBSection(Some(dc), &bmi, DIB_RGB_COLORS, &mut bits, None, 0).ok()?;
    if bits.is_null() {
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        return None;
    }
    let old = SelectObject(dc, HGDIOBJ(bmp.0));

    let mut image: *mut GpBitmap = std::ptr::null_mut();
    if GdipCreateBitmapFromScan0(w, h, w * 4, PF_PARGB, Some(bits as *const u8), &mut image)
        != Status(0)
        || image.is_null()
    {
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        return None;
    }
    let mut gfx: *mut GpGraphics = std::ptr::null_mut();
    if GdipGetImageGraphicsContext(image as *mut GpImage, &mut gfx) != Status(0) || gfx.is_null() {
        GdipDisposeImage(image as *mut GpImage);
        SelectObject(dc, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(dc);
        return None;
    }
    GdipSetSmoothingMode(gfx, SmoothingModeAntiAlias);
    GdipSetTextRenderingHint(gfx, TextRenderingHintAntiAliasGridFit);
    Some(Canvas {
        w,
        h,
        dc,
        bmp,
        old,
        gfx,
        image,
    })
}

unsafe fn canvas_destroy(c: Canvas) {
    GdipDeleteGraphics(c.gfx);
    GdipDisposeImage(c.image as *mut GpImage);
    let _ = SelectObject(c.dc, c.old);
    let _ = DeleteObject(HGDIOBJ(c.bmp.0));
    let _ = DeleteDC(c.dc);
}

/// Pushes the canvas to the screen. `alpha` scales the whole window (fades);
/// per-pixel alpha carries the rounded shape.
unsafe fn canvas_present(a: &App, alpha: u8) {
    let Some(c) = &a.canvas else { return };
    let size = SIZE { cx: c.w, cy: c.h };
    let src = POINT { x: 0, y: 0 };
    let blend = BLENDFUNCTION {
        BlendOp: AC_SRC_OVER as u8,
        BlendFlags: 0,
        SourceConstantAlpha: alpha,
        AlphaFormat: AC_SRC_ALPHA as u8,
    };
    let _ = UpdateLayeredWindow(
        a.hwnd,
        None,
        None,
        Some(&size),
        Some(c.dc),
        Some(&src),
        COLORREF(0),
        Some(&blend),
        ULW_ALPHA,
    );
}

// ------------------------------------------------------------------ install workers

fn cleanup_owned_stage(stage: &Path, expected_parent: &Path) {
    if stage.parent() != Some(expected_parent) {
        return;
    }
    let Ok(meta) = std::fs::symlink_metadata(stage) else {
        return;
    };
    if !meta.is_dir() || meta.file_type().is_symlink() {
        return;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if meta.file_attributes() & 0x400 != 0 {
            return;
        }
    }
    let _ = std::fs::remove_dir_all(stage);
}

fn allowed_shortcut_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    let programs = shell::special_folder(CSIDL_PROGRAMS);
    if !programs.as_os_str().is_empty() {
        paths.push(programs.join("SUNDAY Launcher").join("SUNDAY Launcher.lnk"));
        paths.push(
            programs
                .join(legacy_identity::START_MENU_FOLDER)
                .join(legacy_identity::SHORTCUT_NAME),
        );
    }
    let desktop = shell::special_folder(CSIDL_DESKTOPDIRECTORY);
    if !desktop.as_os_str().is_empty() {
        paths.push(desktop.join("SUNDAY Launcher.lnk"));
        paths.push(desktop.join(legacy_identity::SHORTCUT_NAME));
    }
    paths
}

fn ledger_has_signature(
    document: &ledger::InstallLedger,
    relative: &str,
    identity: &shell::AuthenticodeIdentity,
) -> bool {
    document.signatures.iter().any(|evidence| {
        evidence.path.eq_ignore_ascii_case(relative)
            && evidence.publisher == identity.subject
            && evidence
                .thumbprint
                .eq_ignore_ascii_case(&identity.thumbprint)
    })
}

fn verified_registered_removal(
    require_canonical_runner: bool,
) -> Result<
    (
        shell::InstallRegistration,
        ledger::InstallLedger,
        ledger::RemovalPlan,
    ),
    String,
> {
    let expected_release_identity = release_identity(SUNDAY_RELEASE_PUBLISHER);
    let signed_release = release_is_signed();
    let mut registration = shell::read_install_registration()?;
    if registration.product_guid != PRODUCT_GUID
        || registration.publisher != expected_release_identity
    {
        return Err("Registered SUNDAY Launcher identity does not match this uninstaller.".into());
    }
    let current = fs::canonicalize(
        std::env::current_exe()
            .map_err(|error| format!("Could not identify the running uninstaller: {error}"))?,
    )
    .map_err(|error| format!("Could not canonicalize the running uninstaller: {error}"))?;
    let canonical_uninstaller = registration.install_location.join("uninstall.exe");
    if require_canonical_runner {
        let canonical = fs::canonicalize(&canonical_uninstaller).map_err(|error| {
            format!("Could not locate the registered SUNDAY Launcher uninstaller: {error}")
        })?;
        if !current
            .to_string_lossy()
            .eq_ignore_ascii_case(&canonical.to_string_lossy())
        {
            return Err(
                "A copied or renamed uninstaller has no authority to remove SUNDAY Launcher."
                    .into(),
            );
        }
    }
    let (document, plan) = ledger::verify_removal_plan(
        &registration.ledger_path,
        &registration.install_location,
        &registration.installation_id,
        expected_release_identity,
        &allowed_shortcut_paths(),
    )?;
    if !registration
        .main_binary_name
        .eq_ignore_ascii_case(CURRENT_MAIN_BINARY)
        && !registration
            .main_binary_name
            .eq_ignore_ascii_case(legacy_identity::MAIN_BINARY)
    {
        return Err("Registered SUNDAY Launcher main executable name is not recognized.".into());
    }
    if !document.files.iter().any(|file| {
        file.path
            .eq_ignore_ascii_case(&registration.main_binary_name)
    }) {
        return Err(
            "Registered SUNDAY Launcher main executable does not match the install ledger.".into(),
        );
    }
    if signed_release {
        let current_identity = shell::verify_authenticode(&current, SUNDAY_RELEASE_PUBLISHER)?;
        let uninstall_identity =
            shell::verify_authenticode(&canonical_uninstaller, SUNDAY_RELEASE_PUBLISHER)?;
        if !ledger_has_signature(&document, "uninstall.exe", &uninstall_identity) {
            return Err(
                "Registered uninstaller signature evidence does not match the install ledger."
                    .into(),
            );
        }
        let launcher = registration
            .install_location
            .join(&registration.main_binary_name);
        if launcher.exists() {
            let launcher_identity =
                shell::verify_authenticode(&launcher, SUNDAY_RELEASE_PUBLISHER)?;
            if !ledger_has_signature(
                &document,
                &registration.main_binary_name,
                &launcher_identity,
            ) {
                return Err(
                    "SUNDAY Launcher executable signature evidence does not match the install ledger."
                        .into(),
                );
            }
        }
        if require_canonical_runner && current_identity.thumbprint != uninstall_identity.thumbprint
        {
            return Err("Running uninstaller identity changed during validation.".into());
        }
    } else if !document.signatures.is_empty() {
        return Err("Unsigned installation ledger contains unexpected signature evidence.".into());
    }
    registration = shell::migrate_legacy_registration(&registration)?;
    Ok((registration, document, plan))
}

fn verified_installed_sunday() -> Option<(PathBuf, String)> {
    // Installation discovery carries no mutation authority, but it still must
    // not let a filename or registry path impersonate SUNDAY Launcher. Reuse the full
    // ledger-bound proof before the UI treats an installation as present.
    let (registration, document, _) = verified_registered_removal(false).ok()?;
    Some((registration.install_location, document.version))
}

fn copy_removal_helper(source: &Path, installation_id: &str) -> Result<PathBuf, String> {
    let temporary_root = std::env::temp_dir();
    ensure_plain_directory(&temporary_root)?;
    let helper_guid = GUID::new()
        .map_err(|error| format!("Could not create a removal helper identity: {error}"))?;
    let safe_id = installation_id
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric())
        .take(32)
        .collect::<String>();
    let helper = temporary_root.join(format!(".sunday-uninstall-{safe_id}-{helper_guid:?}.exe"));
    let mut input = fs::File::open(source)
        .map_err(|error| format!("Could not open the SUNDAY Launcher uninstaller: {error}"))?;
    let mut output = fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&helper)
        .map_err(|error| format!("Could not create the removal helper: {error}"))?;
    if let Err(error) = io::copy(&mut input, &mut output).and_then(|_| output.sync_all()) {
        drop(output);
        let _ = fs::remove_file(&helper);
        return Err(format!("Could not copy the removal helper: {error}"));
    }
    drop(output);
    let helper_identity = if release_is_signed() {
        shell::verify_authenticode(&helper, SUNDAY_RELEASE_PUBLISHER).map(|_| ())
    } else {
        let source_size = fs::metadata(source)
            .map_err(|error| format!("Could not inspect the canonical uninstaller: {error}"))?
            .len();
        let helper_size = fs::metadata(&helper)
            .map_err(|error| format!("Could not inspect the removal helper: {error}"))?
            .len();
        if source_size != helper_size || ledger::hash_file(source)? != ledger::hash_file(&helper)? {
            Err("Unsigned removal helper does not match the ledger-bound uninstaller.".into())
        } else {
            Ok(())
        }
    };
    if let Err(error) = helper_identity {
        let _ = fs::remove_file(&helper);
        return Err(error);
    }
    Ok(helper)
}

fn launch_removal_helper() -> Result<(), String> {
    let (registration, _, _) = verified_registered_removal(true)?;
    let current = std::env::current_exe()
        .map_err(|error| format!("Could not identify the running uninstaller: {error}"))?;
    let helper = copy_removal_helper(&current, &registration.installation_id)?;
    let child = Command::new(&helper)
        .arg(format!(
            "--uninstall-helper={}",
            registration.installation_id
        ))
        .arg(format!("--parent-pid={}", std::process::id()))
        .spawn();
    if let Err(error) = child {
        let _ = fs::remove_file(&helper);
        return Err(format!(
            "Could not start the verified SUNDAY Launcher removal helper: {error}"
        ));
    }
    Ok(())
}

fn run_removal_helper(installation_id: &str, parent_pid: u32) -> Result<(), String> {
    let current = fs::canonicalize(
        std::env::current_exe()
            .map_err(|error| format!("Could not identify the removal helper: {error}"))?,
    )
    .map_err(|error| format!("Could not canonicalize the removal helper: {error}"))?;
    let temporary_root = fs::canonicalize(std::env::temp_dir())
        .map_err(|error| format!("Could not canonicalize the temporary directory: {error}"))?;
    let in_temporary_root = current
        .parent()
        .map(|parent| {
            parent
                .to_string_lossy()
                .eq_ignore_ascii_case(&temporary_root.to_string_lossy())
        })
        .unwrap_or(false);
    let helper_name = current
        .file_name()
        .and_then(|name| name.to_str())
        .map(|name| name.starts_with(".sunday-uninstall-") && name.ends_with(".exe"))
        .unwrap_or(false);
    if !in_temporary_root || !helper_name {
        return Err("Removal helper is not running from its controlled temporary location.".into());
    }
    if release_is_signed() {
        shell::verify_authenticode(&current, SUNDAY_RELEASE_PUBLISHER)?;
    }
    let parent = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, false, parent_pid) }.map_err(|_| {
        "Removal helper could not bind the canonical uninstaller process.".to_string()
    })?;
    let (registration, document, plan) = verified_registered_removal(false)?;
    if registration.installation_id != installation_id {
        unsafe {
            let _ = CloseHandle(parent);
        }
        return Err("Removal helper installation identity does not match the registry.".into());
    }
    if !release_is_signed() {
        let expected = document
            .files
            .iter()
            .find(|file| file.path.eq_ignore_ascii_case("uninstall.exe"))
            .ok_or("Unsigned installation ledger is missing uninstaller evidence.")?;
        let current_size = fs::metadata(&current)
            .map_err(|error| format!("Could not inspect the removal helper: {error}"))?
            .len();
        if current_size != expected.size || ledger::hash_file(&current)? != expected.sha256 {
            unsafe {
                let _ = CloseHandle(parent);
            }
            return Err(
                "Unsigned removal helper does not match the ledger-bound uninstaller.".into(),
            );
        }
    }
    let wait = unsafe { WaitForSingleObject(parent, 120_000) };
    unsafe {
        let _ = CloseHandle(parent);
    }
    if wait.0 != 0 {
        return Err(
            "Canonical SUNDAY Launcher uninstaller did not exit within the removal timeout.".into(),
        );
    }
    ledger::execute_removal(&plan)?;
    shell::remove_install_registration(
        &registration.installation_id,
        PRODUCT_GUID,
        &registration.install_location,
    )?;
    let _ = ledger::finish_removal(&plan)?;
    let wide = to_wide(&current.to_string_lossy());
    unsafe {
        let _ = MoveFileExW(
            PCWSTR(wide.as_ptr()),
            PCWSTR::null(),
            MOVEFILE_DELAY_UNTIL_REBOOT,
        );
    }
    Ok(())
}

fn run_install(dest: &Path, desktop: bool, version: &str, tx: &Sender<Msg>) -> Result<(), String> {
    debug_log("run_install start");
    let signed_release = release_is_signed();
    let expected_release_identity = release_identity(SUNDAY_RELEASE_PUBLISHER);
    let installer_identity = if signed_release {
        let current_installer = std::env::current_exe()
            .map_err(|error| format!("Could not identify the running installer: {error}"))?;
        Some(shell::verify_authenticode(
            &current_installer,
            SUNDAY_RELEASE_PUBLISHER,
        )?)
    } else {
        None
    };
    let dest = validate_install_destination(dest)?;
    let dest = &dest;
    if let Ok(meta) = std::fs::symlink_metadata(dest) {
        if meta.file_type().is_symlink() {
            return Err(
                "Installation through a link or reparse-point directory is not allowed.".into(),
            );
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if meta.file_attributes() & 0x400 != 0 {
                return Err(
                    "Installation through a link or reparse-point directory is not allowed.".into(),
                );
            }
        }
        let mut entries = std::fs::read_dir(dest)
            .map_err(|e| format!("Could not inspect {}:\n{e}", dest.display()))?;
        if entries.next().is_some() {
            return Err(
                "SUNDAY Launcher only installs into a new, empty directory. Choose another folder."
                    .into(),
            );
        }
    }
    // Install only the closed-world, manifest-hashed payload. Signed builds add
    // Authenticode publisher verification; unsigned builds remain explicitly
    // integrity-only and rely on the published whole-installer SHA-256.
    let pkg =
        Package::open().ok_or("This installer is incomplete.\nDownload SUNDAY Launcher again.")?;
    let entries = pkg.entries()?;
    let total: u64 = entries.iter().map(|e| e.raw_size).sum();

    let parent = dest
        .parent()
        .ok_or("The installation directory has no parent.")?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("Could not create {}:\n{e}", parent.display()))?;
    ensure_plain_directory(parent)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "The system clock cannot create a staging identity.")?
        .as_nanos();
    let stage = parent.join(format!(".sunday-stage-{}-{stamp}", std::process::id()));
    std::fs::create_dir(&stage)
        .map_err(|e| format!("Could not create controlled staging directory:\n{e}"))?;

    let _ = tx.send(Msg::Note("Copying files…".into()));
    let tx2 = tx.clone();
    let verified = match pkg
        .extract(&entries, &stage, |p| {
            let _ = tx2.send(Msg::Bytes(p.done_bytes, p.total_bytes));
            let _ = tx2.send(Msg::File(p.file.to_string()));
        })
        .and_then(|_| pkg.verify_install_manifest(&entries, &stage, version))
    {
        Ok(verified) => verified,
        Err(error) => {
            cleanup_owned_stage(&stage, parent);
            return Err(error);
        }
    };
    if verified
        .files
        .iter()
        .any(|file| file.path.eq_ignore_ascii_case("WebView2Setup.exe"))
    {
        cleanup_owned_stage(&stage, parent);
        return Err("The release payload contains an executable dependency bootstrapper; installation is blocked.".into());
    }
    let (sunday_identity, uninstall_identity) = if signed_release {
        let sunday_identity = match shell::verify_authenticode(
            &stage.join(CURRENT_MAIN_BINARY),
            SUNDAY_RELEASE_PUBLISHER,
        ) {
            Ok(identity) => identity,
            Err(error) => {
                cleanup_owned_stage(&stage, parent);
                return Err(error);
            }
        };
        let uninstall_identity = match shell::verify_authenticode(
            &stage.join("uninstall.exe"),
            SUNDAY_RELEASE_PUBLISHER,
        ) {
            Ok(identity) => identity,
            Err(error) => {
                cleanup_owned_stage(&stage, parent);
                return Err(error);
            }
        };
        (Some(sunday_identity), Some(uninstall_identity))
    } else {
        (None, None)
    };

    // The destination was proven absent or empty above. Activation is one
    // directory rename, never a file-by-file mutation of an existing tree.
    if dest.exists() {
        std::fs::remove_dir(dest)
            .map_err(|e| format!("Could not activate the staged installation:\n{e}"))?;
    }
    if let Err(error) = std::fs::rename(&stage, dest) {
        cleanup_owned_stage(&stage, parent);
        return Err(format!(
            "Could not activate the staged installation:\n{error}"
        ));
    }

    let _ = tx.send(Msg::Note("Finalizing…".into()));
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }

    let exe = dest.join(CURRENT_MAIN_BINARY);
    let uninstall = dest.join("uninstall.exe");
    let est_kb = total.div_ceil(1024) as u32;
    let installation_guid = match GUID::new() {
        Ok(guid) => guid,
        Err(error) => {
            ledger::rollback_new_install(dest, &verified.files, &[]);
            return Err(format!(
                "Could not create an installation identity: {error}"
            ));
        }
    };
    let installation_id = format!("{{{installation_guid:?}}}");
    let mut shortcuts = Vec::new();
    let programs = shell::special_folder(CSIDL_PROGRAMS);
    if !programs.as_os_str().is_empty() {
        let sm_dir = programs.join("SUNDAY Launcher");
        if let Err(error) = std::fs::create_dir_all(&sm_dir) {
            ledger::rollback_new_install(dest, &verified.files, &shortcuts);
            return Err(format!(
                "Could not create the SUNDAY Launcher Start Menu folder: {error}"
            ));
        }
        if let Err(error) = ensure_plain_directory(&sm_dir) {
            ledger::rollback_new_install(dest, &verified.files, &shortcuts);
            return Err(error);
        }
        let shortcut = sm_dir.join("SUNDAY Launcher.lnk");
        if shortcut.exists() {
            ledger::rollback_new_install(dest, &verified.files, &shortcuts);
            return Err(
                "SUNDAY Launcher will not overwrite an existing Start Menu shortcut.".into(),
            );
        }
        if let Err(error) = shell::create_shortcut(
            &shortcut,
            &exe,
            dest,
            "SUNDAY Launcher - Roblox account and process management",
        ) {
            ledger::rollback_new_install(dest, &verified.files, &shortcuts);
            return Err(error);
        }
        match ledger::snapshot_shortcut(&shortcut) {
            Ok(evidence) => shortcuts.push(evidence),
            Err(error) => {
                ledger::rollback_new_install(dest, &verified.files, &shortcuts);
                return Err(error);
            }
        }
    }

    if desktop {
        let desktop_dir = shell::special_folder(CSIDL_DESKTOPDIRECTORY);
        if !desktop_dir.as_os_str().is_empty() {
            if let Err(error) = ensure_plain_directory(&desktop_dir) {
                ledger::rollback_new_install(dest, &verified.files, &shortcuts);
                return Err(error);
            }
            let shortcut = desktop_dir.join("SUNDAY Launcher.lnk");
            if shortcut.exists() {
                ledger::rollback_new_install(dest, &verified.files, &shortcuts);
                return Err(
                    "SUNDAY Launcher will not overwrite an existing desktop shortcut.".into(),
                );
            }
            if let Err(error) = shell::create_shortcut(
                &shortcut,
                &exe,
                dest,
                "SUNDAY Launcher - Roblox account and process management",
            ) {
                ledger::rollback_new_install(dest, &verified.files, &shortcuts);
                return Err(error);
            }
            match ledger::snapshot_shortcut(&shortcut) {
                Ok(evidence) => shortcuts.push(evidence),
                Err(error) => {
                    ledger::rollback_new_install(dest, &verified.files, &shortcuts);
                    return Err(error);
                }
            }
        }
    }

    let signatures = match (installer_identity, sunday_identity, uninstall_identity) {
        (Some(installer), Some(sunday), Some(uninstaller)) => vec![
            AuthenticodeEvidence {
                path: "installer".into(),
                publisher: installer.subject,
                thumbprint: installer.thumbprint,
            },
            AuthenticodeEvidence {
                path: CURRENT_MAIN_BINARY.into(),
                publisher: sunday.subject,
                thumbprint: sunday.thumbprint,
            },
            AuthenticodeEvidence {
                path: "uninstall.exe".into(),
                publisher: uninstaller.subject,
                thumbprint: uninstaller.thumbprint,
            },
        ],
        (None, None, None) => Vec::new(),
        _ => return Err("Release identity verification did not complete consistently.".into()),
    };
    let ledger_path = match ledger::write_ledger(
        dest,
        &installation_id,
        version,
        expected_release_identity,
        &verified.files,
        &shortcuts,
        signatures,
    ) {
        Ok(path) => path,
        Err(error) => {
            ledger::rollback_new_install(dest, &verified.files, &shortcuts);
            return Err(error);
        }
    };
    if let Err(error) = shell::write_install_entries(
        dest,
        &exe,
        &uninstall,
        version,
        est_kb,
        &installation_id,
        PRODUCT_GUID,
        &ledger_path,
        expected_release_identity,
    ) {
        ledger::rollback_new_install(dest, &verified.files, &shortcuts);
        return Err(error);
    }

    debug_log("run_install ok");
    Ok(())
}

fn validate_install_destination(dest: &Path) -> Result<PathBuf, String> {
    if !dest.is_absolute()
        || dest
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
    {
        return Err("The installation directory must be an absolute, normalized path.".into());
    }
    let leaf = dest
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| {
            !name.is_empty() && !name.ends_with('.') && !name.ends_with(' ') && !name.contains(':')
        })
        .ok_or("The installation directory name is not safe.")?;
    let local = shell::local_app_data()
        .ok_or("Windows could not resolve the current user's LocalAppData directory; installation is blocked.")?;
    ensure_plain_directory(&local)?;
    let canonical_local = fs::canonicalize(&local)
        .map_err(|error| format!("Could not canonicalize LocalAppData: {error}"))?;
    let parent = dest
        .parent()
        .ok_or("The installation directory has no parent.")?;
    ensure_plain_directory(parent)?;
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("The installation parent must already exist: {error}"))?;
    if !canonical_parent.starts_with(&canonical_local) {
        return Err("SUNDAY Launcher installs only into a dedicated directory beneath the current user's LocalAppData tree.".into());
    }
    Ok(canonical_parent.join(leaf))
}

// ------------------------------------------------------------------ window proc

unsafe extern "system" fn wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_NCCREATE => {
            let scale = {
                let dpi = GetDpiForWindow(hwnd);
                if dpi == 0 {
                    1.0
                } else {
                    dpi as f32 / 96.0
                }
            };

            let mut uninstall = false;
            #[cfg(debug_assertions)]
            let mut demo = false;
            let mut preset_path: Option<String> = None;
            for arg in std::env::args().skip(1) {
                let low = arg.to_ascii_lowercase();
                if low == "--uninstall" || low == "/uninstall" {
                    uninstall = true;
                    continue;
                }
                #[cfg(debug_assertions)]
                if low == "--demo" {
                    demo = true;
                    continue;
                }
                if let Some(p) = arg.strip_prefix("--path=") {
                    preset_path = Some(p.to_string());
                }
            }
            // A payload-less binary is the installed uninstaller. It still has
            // no authority unless registry, ledger, path and signatures agree.
            if !Package::exists() {
                uninstall = true;
            }

            let default_path = shell::local_app_data()
                .map(|path| path.join("SUNDAY Launcher").to_string_lossy().to_string())
                .unwrap_or_default();
            // Existing installations are displayed but never mutated by this
            // fresh-install-only package.
            let installed = if uninstall {
                None
            } else {
                verified_installed_sunday()
            };

            // A copied or renamed payload-less executable has no ownership
            // authority, so its parent directory is never recorded as a
            // removal target.
            let path = if uninstall {
                String::new()
            } else if let Some((dir, _)) = &installed {
                dir.to_string_lossy().to_string()
            } else {
                preset_path.unwrap_or(default_path)
            };

            let desktop_shortcut = true;

            let fonts = build_fonts(scale);
            let app = Box::new(App {
                hwnd,
                canvas: None,
                fonts,
                scale,
                uninstall_mode: uninstall,
                #[cfg(debug_assertions)]
                demo,
                stage: if uninstall {
                    Stage::UninstallConfirm
                } else if installed.is_some() {
                    Stage::UpToDate
                } else {
                    Stage::Fresh
                },
                widgets: Vec::new(),
                hot: None,
                pressed: None,
                focus: None,
                caret_on: true,
                alpha: 0,
                progress: 0.0,
                path,
                desktop_shortcut,
                last_error: String::new(),
                install_dest: PathBuf::new(),
                rx: None,
                busy: false,
                fade: Fade {
                    active: false,
                    from: 0,
                    to: 255,
                    t0: 0,
                    dur: 1,
                    after: After::None,
                },
                installed,
                relaunch_ok: None,
            });
            let raw = Box::into_raw(app);
            SetWindowLongPtrW(hwnd, GWLP_USERDATA, raw as isize);
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        WM_ERASEBKGND => LRESULT(1),

        WM_NCHITTEST => {
            // Drag anywhere that is not an interactive widget; there is no
            // caption to do it for us.
            if let Some(a) = app_from(hwnd) {
                let mut pt = POINT {
                    x: (lparam.0 & 0xFFFF) as u16 as i16 as i32,
                    y: ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32,
                };
                if ScreenToClient(hwnd, &mut pt).as_bool() {
                    let hit = widget_at(a, pt.x, pt.y);
                    if hit.is_some() {
                        return LRESULT(HTCLIENT as isize);
                    }
                    return LRESULT(HTCAPTION as isize);
                }
            }
            DefWindowProcW(hwnd, msg, wparam, lparam)
        }

        // A borderless fixed-size window has no business maximizing.
        WM_NCLBUTTONDBLCLK => LRESULT(0),

        WM_TIMER => {
            if let Some(a) = app_from(hwnd) {
                match wparam.0 {
                    IDT_FADE => step_fade(a),
                    #[cfg(debug_assertions)]
                    IDT_DEMO => {
                        let _ = KillTimer(Some(hwnd), IDT_DEMO);
                        demo_advance(a);
                    }
                    IDT_POLL => poll_worker(a),
                    IDT_CARET => {
                        a.caret_on = !a.caret_on;
                        render_present(a);
                    }
                    IDT_HOVER => {
                        clear_stale_hover(a);
                    }
                    _ => {}
                }
            }
            LRESULT(0)
        }

        WM_MOUSEMOVE => {
            if let Some(a) = app_from(hwnd) {
                let x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
                let hit = widget_at(a, x, y);
                if hit != a.hot {
                    a.hot = hit;
                    if hit.is_some() {
                        let _ = SetTimer(Some(hwnd), IDT_HOVER, 80, None);
                    }
                    render_present(a);
                }
            }
            LRESULT(0)
        }

        WM_LBUTTONDOWN => {
            if let Some(a) = app_from(hwnd) {
                let x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
                if let Some(id) = widget_at(a, x, y) {
                    a.pressed = Some(id);
                    if is_focusable(a, id) {
                        a.focus = Some(id);
                    }
                    render_present(a);
                }
            }
            LRESULT(0)
        }

        WM_LBUTTONUP => {
            if let Some(a) = app_from(hwnd) {
                let x = (lparam.0 & 0xFFFF) as u16 as i16 as i32;
                let y = ((lparam.0 >> 16) & 0xFFFF) as u16 as i16 as i32;
                let hit = widget_at(a, x, y);
                let pressed = a.pressed.take();
                if let (Some(p), Some(h)) = (pressed, hit) {
                    if p == h {
                        activate(a, p);
                    }
                }
                render_present(a);
            }
            LRESULT(0)
        }

        WM_KEYDOWN => {
            if let Some(a) = app_from(hwnd) {
                on_keydown(a, wparam.0 as u16);
            }
            LRESULT(0)
        }

        WM_CHAR => {
            if let Some(a) = app_from(hwnd) {
                on_char(a, wparam.0 as u32);
            }
            LRESULT(0)
        }

        WM_CLOSE => {
            if let Some(a) = app_from(hwnd) {
                // While files are moving there is no safe way out; the close
                // button dims and the request is ignored.
                if !a.busy {
                    fade_quit(a);
                }
            }
            LRESULT(0)
        }

        WM_DPICHANGED => {
            if let Some(a) = app_from(hwnd) {
                let new_dpi = ((wparam.0 >> 16) & 0xffff) as u32;
                a.scale = if new_dpi == 0 {
                    1.0
                } else {
                    new_dpi as f32 / 96.0
                };
                let suggested = &*(lparam.0 as *const RECT);
                let _ = SetWindowPos(
                    hwnd,
                    Some(HWND_TOP),
                    suggested.left,
                    suggested.top,
                    suggested.right - suggested.left,
                    suggested.bottom - suggested.top,
                    SWP_NOZORDER | SWP_NOACTIVATE,
                );
                rebuild_fonts(a);
                rebuild_canvas(a);
                build_stage(a);
                render_present(a);
            }
            LRESULT(0)
        }

        WM_NCDESTROY => {
            if let Some(a) = app_from(hwnd) {
                if let Some(c) = a.canvas.take() {
                    canvas_destroy(c);
                }
            }
            let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
            if raw != 0 {
                drop(Box::from_raw(raw as *mut App));
                SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0);
            }
            let r = DefWindowProcW(hwnd, msg, wparam, lparam);
            // The graceful exit path (fade_quit -> DestroyWindow) never posted
            // WM_QUIT, so the pump would block forever. This runs exactly once
            // per process.
            PostQuitMessage(0);
            r
        }

        _ => DefWindowProcW(hwnd, msg, wparam, lparam),
    }
}

// ------------------------------------------------------------------ app plumbing

fn app_from(hwnd: HWND) -> Option<&'static mut App> {
    unsafe {
        let raw = GetWindowLongPtrW(hwnd, GWLP_USERDATA);
        if raw == 0 {
            None
        } else {
            Some(&mut *(raw as *mut App))
        }
    }
}

fn size_window(a: &App) {
    unsafe {
        let w = (WIN_W as f32 * a.scale).round() as i32;
        let h = (WIN_H as f32 * a.scale).round() as i32;

        let mut work = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        let got = SystemParametersInfoW(
            SPI_GETWORKAREA,
            0,
            Some(&mut work as *mut RECT as *mut core::ffi::c_void),
            Default::default(),
        )
        .is_ok();
        let (x, y) = if got && work.right > work.left {
            (
                work.left + (work.right - work.left - w) / 2,
                work.top + (work.bottom - work.top - h) / 2,
            )
        } else {
            (CW_USEDEFAULT, CW_USEDEFAULT)
        };
        let _ = SetWindowPos(
            a.hwnd,
            Some(HWND_TOP),
            x,
            y,
            w,
            h,
            SWP_NOZORDER | SWP_NOACTIVATE,
        );
    }
}

fn rebuild_fonts(a: &mut App) {
    unsafe {
        delete_fonts(&a.fonts);
    }
    a.fonts = unsafe { build_fonts(a.scale) };
}

fn rebuild_canvas(a: &mut App) {
    unsafe {
        if let Some(c) = a.canvas.take() {
            canvas_destroy(c);
        }
        let w = (WIN_W as f32 * a.scale).round() as i32;
        let h = (WIN_H as f32 * a.scale).round() as i32;
        a.canvas = canvas_create(w, h);
    }
}

fn start_fade(a: &mut App, to: u8, dur: u32, after: After) {
    a.fade = Fade {
        active: true,
        from: a.alpha,
        to,
        t0: unsafe { GetTickCount64() },
        dur,
        after,
    };
    unsafe {
        let _ = SetTimer(Some(a.hwnd), IDT_FADE, 16, None);
        step_fade(a);
    }
}

unsafe fn step_fade(a: &mut App) {
    if !a.fade.active {
        let _ = KillTimer(Some(a.hwnd), IDT_FADE);
        return;
    }
    let now = GetTickCount64();
    let t = ((now - a.fade.t0) as f32 / a.fade.dur.max(1) as f32).clamp(0.0, 1.0);
    let eased = t * t * (3.0 - 2.0 * t);
    let alpha = (a.fade.from as f32 + (a.fade.to as f32 - a.fade.from as f32) * eased)
        .clamp(0.0, 255.0) as u8;
    a.alpha = alpha;
    canvas_present(a, alpha);
    if t >= 1.0 {
        let after = std::mem::replace(&mut a.fade.after, After::None);
        a.fade.active = false;
        let _ = KillTimer(Some(a.hwnd), IDT_FADE);
        if let After::Quit = after {
            let _ = DestroyWindow(a.hwnd);
        }
    }
}

fn fade_quit(a: &mut App) {
    start_fade(a, 0, 180, After::Quit);
}

/// One page: state changes rebuild the widget list in place.
fn goto_stage(a: &mut App, next: Stage) {
    a.stage = next;
    build_stage(a);
    render_present(a);
}

impl App {
    /// The version covered by this installer's signed embedded payload.
    fn version_to_install(&self) -> String {
        SUNDAY_VERSION.to_string()
    }
}

// ------------------------------------------------------------------ drawing

/// Builds a closed rounded-rectangle path (device pixels).
unsafe fn rounded_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> *mut GpPath {
    let mut path: *mut GpPath = std::ptr::null_mut();
    if GdipCreatePath(FillModeAlternate, &mut path) != Status(0) {
        return std::ptr::null_mut();
    }
    let d = 2.0 * r;
    GdipAddPathArc(path, x, y, d, d, 180.0, 90.0);
    GdipAddPathArc(path, x + w - d, y, d, d, 270.0, 90.0);
    GdipAddPathArc(path, x + w - d, y + h - d, d, d, 0.0, 90.0);
    GdipAddPathArc(path, x, y + h - d, d, d, 90.0, 90.0);
    GdipClosePathFigures(path);
    path
}

unsafe fn fill_path(gfx: *mut GpGraphics, path: *mut GpPath, color: u32) {
    let mut brush: *mut GpSolidFill = std::ptr::null_mut();
    GdipCreateSolidFill(argb(color), &mut brush);
    GdipFillPath(gfx, brush as *mut GpBrush, path);
    GdipDeleteBrush(brush as *mut GpBrush);
}

unsafe fn stroke_path(gfx: *mut GpGraphics, path: *mut GpPath, color: u32, width: f32) {
    let mut pen: *mut GpPen = std::ptr::null_mut();
    GdipCreatePen1(argb(color), width, UnitPixel, &mut pen);
    GdipDrawPath(gfx, pen, path);
    GdipDeletePen(pen);
}

/// Stroke with a raw ARGB color (one that carries its own alpha).
unsafe fn stroke_path_argb(gfx: *mut GpGraphics, path: *mut GpPath, color: u32, width: f32) {
    let mut pen: *mut GpPen = std::ptr::null_mut();
    GdipCreatePen1(color, width, UnitPixel, &mut pen);
    GdipDrawPath(gfx, pen, path);
    GdipDeletePen(pen);
}

unsafe fn fill_rect(gfx: *mut GpGraphics, color: u32, x: i32, y: i32, w: i32, h: i32) {
    let mut brush: *mut GpSolidFill = std::ptr::null_mut();
    GdipCreateSolidFill(argb(color), &mut brush);
    GdipFillRectangleI(gfx, brush as *mut GpBrush, x, y, w, h);
    GdipDeleteBrush(brush as *mut GpBrush);
}

/// Single-line or wrapping text with GDI+ anti-aliasing.
unsafe fn draw_text(
    gfx: *mut GpGraphics,
    text: &str,
    font: *mut GpFont,
    color: u32,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    align: Align,
    wrap: bool,
    top: bool,
) {
    let mut fmt: *mut GpStringFormat = std::ptr::null_mut();
    if GdipCreateStringFormat(0, 0, &mut fmt) != Status(0) || fmt.is_null() {
        return;
    }
    if !wrap {
        GdipSetStringFormatFlags(fmt, StringFormatFlagsNoWrap.0);
        GdipSetStringFormatTrimming(fmt, StringTrimmingEllipsisCharacter);
    }
    let halign = match align {
        Align::Left => StringAlignmentNear,
        Align::Center => StringAlignmentCenter,
        Align::Right => StringAlignmentFar,
    };
    let valign = if top {
        StringAlignmentNear
    } else {
        StringAlignmentCenter
    };
    GdipSetStringFormatAlign(fmt, halign);
    GdipSetStringFormatLineAlign(fmt, valign);

    let mut brush: *mut GpSolidFill = std::ptr::null_mut();
    GdipCreateSolidFill(argb(color), &mut brush);
    let rc = RectF {
        X: x,
        Y: y,
        Width: w,
        Height: h,
    };
    let wide = to_wide(text);
    GdipDrawString(
        gfx,
        PCWSTR(wide.as_ptr()),
        -1,
        font,
        &rc,
        fmt,
        brush as *mut GpBrush,
    );
    GdipDeleteBrush(brush as *mut GpBrush);
    GdipDeleteStringFormat(fmt);
}

/// Advance width of one line of text, in device pixels.
unsafe fn measure_text_width(gfx: *mut GpGraphics, text: &str, font: *mut GpFont) -> f32 {
    let mut fmt: *mut GpStringFormat = std::ptr::null_mut();
    if GdipCreateStringFormat(0, 0, &mut fmt) != Status(0) || fmt.is_null() {
        return 0.0;
    }
    GdipSetStringFormatFlags(fmt, StringFormatFlagsNoWrap.0);
    let layout = RectF {
        X: 0.0,
        Y: 0.0,
        Width: 100_000.0,
        Height: 1_000.0,
    };
    let mut bbox = RectF {
        X: 0.0,
        Y: 0.0,
        Width: 0.0,
        Height: 0.0,
    };
    let mut fitted: i32 = 0;
    let mut lines: i32 = 0;
    let wide = to_wide(text);
    GdipMeasureString(
        gfx,
        PCWSTR(wide.as_ptr()),
        -1,
        font,
        &layout,
        fmt,
        &mut bbox,
        &mut fitted,
        &mut lines,
    );
    GdipDeleteStringFormat(fmt);
    bbox.Width
}

/// Trims a path to its visible tail: an ellipsis plus as much of the end as
/// fits. Suffix length is binary-searched; width grows monotonically with it.
unsafe fn tail_to_fit(gfx: *mut GpGraphics, font: *mut GpFont, text: &str, avail: f32) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.is_empty() {
        return String::new();
    }
    let with_len = |n: usize| -> String {
        std::iter::once('\u{2026}')
            .chain(chars[chars.len() - n..].iter().copied())
            .collect()
    };
    let mut lo = 1usize; // always keep at least the final character
    let mut hi = chars.len();
    while lo < hi {
        let mid = (lo + hi).div_ceil(2);
        if measure_text_width(gfx, &with_len(mid), font) <= avail {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    with_len(lo)
}

/// One push button: an anti-aliased 6px-rounded fill with centered label.
/// Mirrors the app's .btn, .btn.primary and .btn.danger styles.
unsafe fn draw_button(
    gfx: *mut GpGraphics,
    s: f32,
    fonts: &Fonts,
    wg: &Wg,
    label: &str,
    primary: bool,
    danger: bool,
    enabled: bool,
    hot: bool,
    pressed: bool,
    focused: bool,
) {
    let (fill, border, text) = if primary {
        if !enabled {
            (PRIM_OFF, None, PRIM_OFF_TX)
        } else if pressed {
            (PRIM_DOWN, None, ON_INK)
        } else if hot {
            (ACCENT, None, ON_INK)
        } else {
            (PRIM, None, ON_INK)
        }
    } else if danger {
        if pressed {
            (DANGER_DOWN, Some(DANGER_RING), DANGER)
        } else if hot {
            (DANGER_HOT, Some(DANGER_EDGE), DANGER)
        } else {
            (BG, Some(DANGER_RING), DANGER)
        }
    } else if !enabled {
        (SEC_OFF, Some(HAIR), INK_3)
    } else if pressed {
        (SURFACE_3, Some(HAIR_HOT), INK)
    } else if hot {
        (SURFACE_2, Some(HAIR_HOT), INK)
    } else {
        (SURFACE, Some(HAIR_2), INK)
    };

    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let r = (BTN_RADIUS * s).min(w / 2.0).min(h / 2.0).max(0.0);

    let path = rounded_path(x, y, w, h, r);
    if !path.is_null() {
        fill_path(gfx, path, fill);
        if let Some(b) = border {
            let bw = if s >= 2.0 { 2.0 } else { 1.0 };
            stroke_path(gfx, path, b, bw);
        }
        GdipDeletePath(path);
    }
    if focused && enabled {
        // The app's focus style: a 2px outline sitting 1px clear of the edge.
        let out = 2.0 * s; // the 1px gap plus half the stroke
        let fpath = rounded_path(x - out, y - out, w + 2.0 * out, h + 2.0 * out, r + out);
        if !fpath.is_null() {
            stroke_path(gfx, fpath, ACCENT, 2.0 * s);
            GdipDeletePath(fpath);
        }
    }
    draw_text(
        gfx,
        label,
        fonts.label,
        text,
        x,
        y,
        w,
        h,
        Align::Center,
        false,
        false,
    );
}

/// A checkbox row: a 20px rounded box with a check glyph and a label, the
/// app's own selection checkbox.
unsafe fn draw_check(
    gfx: *mut GpGraphics,
    s: f32,
    fonts: &Fonts,
    wg: &Wg,
    label: &str,
    checked: bool,
    hot: bool,
    focused: bool,
) {
    let box_side = 20.0 * s;
    let bx = wg.x * s;
    let by = wg.y * s + (wg.h * s - box_side) / 2.0;
    let r = (4.0 * s).min(box_side / 2.0);

    let path = rounded_path(bx, by, box_side, box_side, r);
    if !path.is_null() {
        fill_path(
            gfx,
            path,
            if checked {
                PRIM
            } else {
                if hot {
                    SURFACE_2
                } else {
                    SURFACE
                }
            },
        );
        stroke_path(
            gfx,
            path,
            if checked { PRIM } else { HAIR_2 },
            if s >= 2.0 { 2.0 } else { 1.0 },
        );
        GdipDeletePath(path);
    }
    if checked {
        // Check glyph: two strokes, sized to the box.
        let cx = bx + box_side / 2.0;
        let cy = by + box_side / 2.0;
        let u = box_side * 0.24;
        let mut pen: *mut GpPen = std::ptr::null_mut();
        GdipCreatePen1(argb(ON_INK), (2.0 * s).max(1.4), UnitPixel, &mut pen);
        GdipDrawLine(gfx, pen, cx - u, cy, cx - u * 0.15, cy + u * 0.85);
        GdipDrawLine(
            gfx,
            pen,
            cx - u * 0.15,
            cy + u * 0.85,
            cx + u,
            cy - u * 0.85,
        );
        GdipDeletePen(pen);
    }
    if focused {
        let fw = 2.0 * s;
        let ring = rounded_path(
            bx - fw,
            by - fw,
            box_side + 2.0 * fw,
            box_side + 2.0 * fw,
            r + fw,
        );
        if !ring.is_null() {
            stroke_path(gfx, ring, ACCENT, if s >= 2.0 { 2.0 } else { 1.0 });
            GdipDeletePath(ring);
        }
    }
    draw_text(
        gfx,
        label,
        fonts.body,
        INK_2,
        bx + box_side + 10.0 * s,
        wg.y * s,
        wg.w * s - box_side - 10.0 * s,
        wg.h * s,
        Align::Left,
        false,
        false,
    );
}

/// The folder field: a dark input surface. Click focuses it for typing; the
/// caret follows the measured text and shows the path's end when it overflows,
/// like a real edit control.
unsafe fn draw_path_field(
    gfx: *mut GpGraphics,
    s: f32,
    fonts: &Fonts,
    wg: &Wg,
    text: &str,
    focused: bool,
    caret_on: bool,
    hot: bool,
) {
    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let r = (BTN_RADIUS * s).min(h / 2.0);
    let path = rounded_path(x, y, w, h, r);
    if !path.is_null() {
        fill_path(gfx, path, if hot { SURFACE_2 } else { SURFACE });
        stroke_path(
            gfx,
            path,
            if focused { ACCENT } else { HAIR_2 },
            if s >= 2.0 { 2.0 } else { 1.0 },
        );
        GdipDeletePath(path);
    }
    if focused {
        // The app's input focus: an accent border with a soft accent halo.
        let out = 2.0 * s;
        let halo = rounded_path(x - out, y - out, w + 2.0 * out, h + 2.0 * out, r + out);
        if !halo.is_null() {
            stroke_path_argb(gfx, halo, HALO_ARGB, 2.0 * s);
            GdipDeletePath(halo);
        }
    }
    let pad = 12.0 * s;
    let avail = w - 2.0 * pad;
    let text_w = measure_text_width(gfx, text, fonts.path);
    if focused && text_w > avail {
        // Keep the end of the path visible: that is where typing happens.
        let tail = tail_to_fit(gfx, fonts.path, text, avail);
        draw_text(
            gfx,
            &tail,
            fonts.path,
            INK,
            x + pad,
            y,
            avail,
            h,
            Align::Left,
            false,
            false,
        );
    } else {
        draw_text(
            gfx,
            text,
            fonts.path,
            INK,
            x + pad,
            y,
            avail,
            h,
            Align::Left,
            false,
            false,
        );
    }
    if focused && caret_on {
        let cx = if text_w > avail {
            x + w - pad
        } else {
            x + pad + text_w
        };
        fill_rect(
            gfx,
            ACCENT,
            cx.round() as i32,
            (y + 8.0 * s).round() as i32,
            (1.6 * s).round().max(1.0) as i32,
            (h - 16.0 * s).round().max(4.0) as i32,
        );
    }
}

/// Flat progress bar: a rounded track with an accent fill.
unsafe fn draw_progress(gfx: *mut GpGraphics, s: f32, wg: &Wg, frac: f32, sweep: Option<i32>) {
    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let r = (h / 2.0).min(3.0 * s);
    let track = rounded_path(x, y, w, h, r);
    if track.is_null() {
        return;
    }
    fill_path(gfx, track, TRACK);
    GdipSetClipPath(gfx, track, CombineModeReplace);
    match sweep {
        Some(pos) => {
            // A short segment gliding across the track.
            let seg = (w * 0.28).max(12.0);
            let t = (pos as f32) / 120.0;
            let cx = x + t * (w + seg) - seg;
            fill_rect(
                gfx,
                ACCENT,
                cx.round() as i32,
                y.round() as i32,
                seg.round() as i32,
                h.round() as i32,
            );
        }
        None => {
            let fw = (w * frac.clamp(0.0, 1.0)).round() as i32;
            if fw > 0 {
                fill_rect(
                    gfx,
                    ACCENT,
                    x.round() as i32,
                    y.round() as i32,
                    fw,
                    h.round() as i32,
                );
            }
        }
    }
    GdipResetClip(gfx);
    GdipDeletePath(track);
}

/// The caption close button: 46x32 at native metrics, red hover like the app.
unsafe fn draw_close_btn(
    gfx: *mut GpGraphics,
    s: f32,
    wg: &Wg,
    window_path: *mut GpPath,
    hot: bool,
    pressed: bool,
    busy: bool,
) {
    let x = wg.x * s;
    let y = wg.y * s;
    let w = wg.w * s;
    let h = wg.h * s;
    let glyph = if busy {
        INK_3
    } else if hot {
        INK
    } else {
        INK_2
    };
    if hot && !busy {
        // The fill is clipped to the window shape so the rounded corner
        // stays clean.
        GdipSetClipPath(gfx, window_path, CombineModeReplace);
        fill_rect(
            gfx,
            if pressed { CLOSE_DOWN } else { CLOSE_HOT },
            x.round() as i32,
            y.round() as i32,
            w.round() as i32,
            h.round() as i32,
        );
        GdipResetClip(gfx);
    }
    // 10px glyph: two crossing strokes.
    let cx = x + w / 2.0;
    let cy = y + h / 2.0;
    let u = 5.0 * s;
    let mut pen: *mut GpPen = std::ptr::null_mut();
    GdipCreatePen1(argb(glyph), (1.0 * s).max(1.0), UnitPixel, &mut pen);
    GdipDrawLine(gfx, pen, cx - u, cy - u, cx + u, cy + u);
    GdipDrawLine(gfx, pen, cx + u, cy - u, cx - u, cy + u);
    GdipDeletePen(pen);
}

/// Renders the whole window into the canvas and presents it at the current
/// fade alpha.
fn render_present(a: &App) {
    unsafe {
        render(a);
    }
    unsafe {
        canvas_present(a, a.alpha);
    }
}

unsafe fn render(a: &App) {
    let Some(c) = &a.canvas else { return };
    let gfx = c.gfx;
    let s = a.scale;
    let window_width = c.w as f32;
    let window_height = c.h as f32;

    GdipGraphicsClear(gfx, 0x0000_0000); // fully transparent

    // Window shape: 8px anti-aliased rounded rectangle.
    let radius = WIN_RADIUS * s;
    let window_path = rounded_path(0.0, 0.0, window_width, window_height, radius);
    if window_path.is_null() {
        return;
    }
    fill_path(gfx, window_path, BG);

    // Header: wordmark, tagline, version, close button, hairline.
    draw_text(
        gfx,
        "SUNDAY",
        a.fonts.display,
        INK,
        36.0 * s,
        26.0 * s,
        300.0 * s,
        34.0 * s,
        Align::Left,
        false,
        false,
    );
    draw_text(
        gfx,
        "Multi-instance Roblox launcher",
        a.fonts.small,
        INK_3,
        36.0 * s,
        62.0 * s,
        320.0 * s,
        18.0 * s,
        Align::Left,
        false,
        false,
    );
    let version_line = format!("v{}", a.version_to_install());
    draw_text(
        gfx,
        &version_line,
        a.fonts.small,
        INK_3,
        324.0 * s,
        34.0 * s,
        (WIN_W as f32 - 324.0 - CLOSE_W as f32 - 12.0) * s,
        18.0 * s,
        Align::Right,
        false,
        false,
    );

    for wg in &a.widgets {
        match &wg.kind {
            WgKind::CloseBtn => {
                draw_close_btn(
                    gfx,
                    s,
                    wg,
                    window_path,
                    a.hot == Some(wg.id),
                    a.pressed == Some(wg.id),
                    a.busy,
                );
            }
            WgKind::Button {
                label,
                primary,
                danger,
                enabled,
            } => {
                draw_button(
                    gfx,
                    s,
                    &a.fonts,
                    wg,
                    label,
                    *primary,
                    *danger,
                    *enabled,
                    a.hot == Some(wg.id),
                    a.pressed == Some(wg.id),
                    a.focus == Some(wg.id),
                );
            }
            WgKind::Check { label, checked } => {
                draw_check(
                    gfx,
                    s,
                    &a.fonts,
                    wg,
                    label,
                    *checked,
                    a.hot == Some(wg.id),
                    a.focus == Some(wg.id),
                );
            }
            WgKind::PathField => {
                draw_path_field(
                    gfx,
                    s,
                    &a.fonts,
                    wg,
                    &a.path,
                    a.focus == Some(IDC_PATHEDIT),
                    a.caret_on,
                    a.hot == Some(IDC_PATHEDIT),
                );
            }
            WgKind::Text {
                text,
                ink,
                align,
                font,
                wrap,
                top,
            } => {
                let fobj = match font {
                    FontRole::Head => a.fonts.head,
                    FontRole::Label => a.fonts.label,
                    FontRole::Body => a.fonts.body,
                    FontRole::Small => a.fonts.small,
                };
                draw_text(
                    gfx,
                    text,
                    fobj,
                    *ink,
                    wg.x * s,
                    wg.y * s,
                    wg.w * s,
                    wg.h * s,
                    *align,
                    *wrap,
                    *top,
                );
            }
            WgKind::Rule => {
                fill_rect(
                    gfx,
                    HAIR,
                    (wg.x * s).round() as i32,
                    (wg.y * s).round() as i32,
                    (wg.w * s).round() as i32,
                    (wg.h * s).round() as i32,
                );
            }
            WgKind::Progress => {
                draw_progress(gfx, s, wg, a.progress, None);
            }
        }
    }

    GdipDeletePath(window_path);
    GdipFlush(gfx, FlushIntentionFlush);
}

// ------------------------------------------------------------------ stage UI

fn add_text(
    a: &mut App,
    id: i32,
    text: String,
    ink: u32,
    font: FontRole,
    align: Align,
    wrap: bool,
    top: bool,
    x: f32,
    y: f32,
    w: f32,
    h: f32,
) {
    a.widgets.push(Wg {
        id,
        kind: WgKind::Text {
            text,
            ink,
            align,
            font,
            wrap,
            top,
        },
        x,
        y,
        w,
        h,
    });
}

fn add_button(a: &mut App, id: i32, label: &str, x: f32, y: f32, w: f32, h: f32, enabled: bool) {
    a.widgets.push(Wg {
        id,
        kind: WgKind::Button {
            label: label.to_string(),
            primary: is_primary(id),
            danger: false,
            enabled,
        },
        x,
        y,
        w,
        h,
    });
}

fn add_check(a: &mut App, id: i32, label: &str, checked: bool, x: f32, y: f32, w: f32, h: f32) {
    a.widgets.push(Wg {
        id,
        kind: WgKind::Check {
            label: label.to_string(),
            checked,
        },
        x,
        y,
        w,
        h,
    });
}

fn add_rule(a: &mut App, y: f32) {
    a.widgets.push(Wg {
        id: IDC_RULE,
        kind: WgKind::Rule,
        x: 36.0,
        y,
        w: 448.0,
        h: 1.0,
    });
}

/// Footer band: hairline, optional hint, optional secondary button, primary.
fn add_footer(
    a: &mut App,
    hint: &str,
    secondary: Option<(&str, i32)>,
    primary_label: &str,
    primary_id: i32,
) {
    add_rule(a, 288.0);
    if let Some((label, id)) = secondary {
        add_button(a, id, label, 232.0, 304.0, 128.0, 32.0, true);
    }
    add_button(
        a,
        primary_id,
        primary_label,
        368.0,
        304.0,
        116.0,
        32.0,
        true,
    );
    if !hint.is_empty() {
        add_text(
            a,
            IDC_HINT,
            hint.to_string(),
            INK_3,
            FontRole::Small,
            Align::Left,
            false,
            false,
            36.0,
            311.0,
            320.0,
            18.0,
        );
    }
}

fn build_stage(a: &mut App) {
    a.widgets.clear();
    a.hot = None;
    a.pressed = None;
    a.progress = 0.0;
    unsafe {
        let _ = KillTimer(Some(a.hwnd), IDT_CARET);
    }

    // Caption close button (always present, dimmed while busy).
    a.widgets.push(Wg {
        id: IDC_CAPCLOSE,
        kind: WgKind::CloseBtn,
        x: (WIN_W - CLOSE_W) as f32,
        y: 0.0,
        w: CLOSE_W as f32,
        h: CLOSE_H as f32,
    });

    // Header hairline.
    add_rule(a, 96.0);

    match a.stage {
        Stage::Fresh => {
            add_text(
                a,
                IDC_LABEL,
                "Install folder".into(),
                INK,
                FontRole::Label,
                Align::Left,
                false,
                false,
                36.0,
                114.0,
                448.0,
                18.0,
            );
            a.widgets.push(Wg {
                id: IDC_PATHEDIT,
                kind: WgKind::PathField,
                x: 36.0,
                y: 138.0,
                w: 316.0,
                h: 32.0,
            });
            add_button(a, IDC_BROWSE, "Browse…", 364.0, 138.0, 120.0, 32.0, true);
            add_text(
                a,
                IDC_ERROR,
                String::new(),
                DANGER,
                FontRole::Small,
                Align::Left,
                false,
                false,
                36.0,
                178.0,
                448.0,
                18.0,
            );
            add_check(
                a,
                IDC_CHECK_DESKTOP,
                "Add a desktop shortcut",
                a.desktop_shortcut,
                36.0,
                214.0,
                320.0,
                24.0,
            );

            add_footer(
                a,
                "No administrator permissions required.",
                None,
                "Install SUNDAY Launcher",
                IDC_INSTALL,
            );
            a.focus = Some(IDC_PATHEDIT);
            unsafe {
                let _ = SetTimer(Some(a.hwnd), IDT_CARET, 530, None);
            }
        }

        Stage::UpToDate => {
            let cur = a
                .installed
                .as_ref()
                .map(|(_, v)| v.clone())
                .unwrap_or_default();
            let eff = a.version_to_install();
            let sub = if version_cmp(&cur, &eff) == std::cmp::Ordering::Equal {
                format!("SUNDAY Launcher v{eff} is already installed.")
            } else {
                format!("SUNDAY Launcher v{cur} is installed; this package contains v{eff}.")
            };
            add_text(
                a,
                IDC_HEAD,
                "Existing installation detected".into(),
                INK,
                FontRole::Head,
                Align::Left,
                false,
                false,
                36.0,
                126.0,
                448.0,
                26.0,
            );
            add_text(
                a,
                IDC_SUB,
                sub,
                INK_2,
                FontRole::Body,
                Align::Left,
                false,
                false,
                36.0,
                156.0,
                448.0,
                20.0,
            );
            add_text(
                a,
                IDC_HINT,
                "In-place update is disabled; no existing files were changed.".into(),
                INK_3,
                FontRole::Small,
                Align::Left,
                true,
                true,
                36.0,
                184.0,
                448.0,
                36.0,
            );
            let secondary = if version_cmp(&cur, &eff) == std::cmp::Ordering::Greater {
                Some(("Get newer version", IDC_RELEASES))
            } else {
                None
            };
            add_footer(a, "", secondary, "Close", IDC_CLOSE);
            a.focus = Some(IDC_CLOSE);
        }

        Stage::Installing => {
            add_text(
                a,
                IDC_HEAD,
                "Installing SUNDAY Launcher…".into(),
                INK,
                FontRole::Head,
                Align::Left,
                false,
                false,
                36.0,
                118.0,
                448.0,
                26.0,
            );
            add_text(
                a,
                IDC_SUB,
                "Copying files…".into(),
                INK_2,
                FontRole::Body,
                Align::Left,
                false,
                false,
                36.0,
                148.0,
                448.0,
                20.0,
            );
            a.widgets.push(Wg {
                id: 0,
                kind: WgKind::Progress,
                x: 36.0,
                y: 178.0,
                w: 448.0,
                h: 8.0,
            });
            add_text(
                a,
                IDC_BYTES,
                String::new(),
                INK_3,
                FontRole::Small,
                Align::Left,
                false,
                false,
                36.0,
                198.0,
                448.0,
                16.0,
            );
            add_text(
                a,
                IDC_FILE,
                String::new(),
                INK_3,
                FontRole::Small,
                Align::Left,
                false,
                false,
                36.0,
                218.0,
                448.0,
                16.0,
            );
        }

        Stage::Done => {
            let dest_text = a.install_dest.to_string_lossy().to_string();
            let installed_version = a.version_to_install();
            add_text(
                a,
                IDC_HEAD,
                "SUNDAY Launcher is installed".into(),
                INK,
                FontRole::Head,
                Align::Left,
                false,
                false,
                36.0,
                118.0,
                448.0,
                26.0,
            );
            add_text(
                a,
                IDC_SUB,
                format!("SUNDAY Launcher v{installed_version} is ready to use."),
                INK_2,
                FontRole::Body,
                Align::Left,
                false,
                false,
                36.0,
                148.0,
                448.0,
                20.0,
            );
            add_text(
                a,
                IDC_HINT,
                dest_text,
                INK_3,
                FontRole::Small,
                Align::Left,
                false,
                false,
                36.0,
                172.0,
                448.0,
                18.0,
            );
            add_footer(
                a,
                "",
                Some(("Close", IDC_CLOSE)),
                "Launch SUNDAY Launcher",
                IDC_LAUNCH,
            );
            a.focus = Some(IDC_LAUNCH);
        }

        Stage::Error => {
            let err_text = a.last_error.clone();
            let head = if a.uninstall_mode {
                "Removal failed"
            } else {
                "Setup failed"
            };
            add_text(
                a,
                IDC_HEAD,
                head.into(),
                INK,
                FontRole::Head,
                Align::Left,
                false,
                false,
                36.0,
                114.0,
                448.0,
                26.0,
            );
            add_text(
                a,
                IDC_SUB,
                err_text,
                INK_2,
                FontRole::Body,
                Align::Left,
                true,
                true,
                36.0,
                144.0,
                448.0,
                120.0,
            );
            if a.uninstall_mode {
                add_footer(a, "", None, "Close", IDC_CLOSE);
                a.focus = Some(IDC_CLOSE);
            } else {
                add_footer(a, "", Some(("Close", IDC_CLOSE)), "Try again", IDC_RETRY);
                a.focus = Some(IDC_RETRY);
            }
        }

        Stage::UninstallConfirm => {
            add_text(
                a,
                IDC_HEAD,
                "Remove SUNDAY Launcher".into(),
                INK,
                FontRole::Head,
                Align::Left,
                false,
                false,
                36.0,
                118.0,
                448.0,
                26.0,
            );
            add_text(
                a,
                IDC_SUB,
                "Only files recorded by this signed SUNDAY Launcher installation will be removed. Modified and unknown files are preserved.".into(),
                INK_2,
                FontRole::Body,
                Align::Left,
                true,
                true,
                36.0,
                148.0,
                448.0,
                40.0,
            );
            add_footer(
                a,
                "",
                Some(("Close", IDC_CLOSE)),
                "Remove SUNDAY Launcher",
                IDC_INSTALL,
            );
            a.focus = Some(IDC_INSTALL);
        }
    }

    #[cfg(debug_assertions)]
    if a.demo {
        let delay: u32 = match a.stage {
            Stage::Fresh => 2200,
            Stage::UpToDate => 2500,
            Stage::Done => 3000,
            Stage::UninstallConfirm => 2000,
            _ => 0,
        };
        if delay > 0 {
            unsafe {
                let _ = SetTimer(Some(a.hwnd), IDT_DEMO, delay, None);
            }
        }
    }
}

// ------------------------------------------------------------------ input

/// The widget under a client point, if it is interactive.
fn widget_at(a: &App, x: i32, y: i32) -> Option<i32> {
    let (x, y) = (x as f32, y as f32);
    let s = a.scale;
    for wg in &a.widgets {
        let interactive = match &wg.kind {
            WgKind::Button { enabled, .. } => *enabled,
            WgKind::Check { .. } => true,
            WgKind::PathField => true,
            WgKind::CloseBtn => true,
            _ => false,
        };
        if !interactive {
            continue;
        }
        if x >= wg.x * s && x < (wg.x + wg.w) * s && y >= wg.y * s && y < (wg.y + wg.h) * s {
            return Some(wg.id);
        }
    }
    None
}

fn is_focusable(a: &App, id: i32) -> bool {
    a.widgets.iter().any(|wg| {
        wg.id == id
            && match &wg.kind {
                WgKind::Button { enabled, .. } => *enabled,
                WgKind::Check { .. } | WgKind::PathField => true,
                _ => false,
            }
    })
}

/// Focusable widget ids in draw order (Tab order).
fn focus_ids(a: &App) -> Vec<i32> {
    a.widgets
        .iter()
        .filter(|wg| match &wg.kind {
            WgKind::Button { enabled, .. } => *enabled,
            WgKind::Check { .. } | WgKind::PathField => true,
            _ => false,
        })
        .map(|wg| wg.id)
        .collect()
}

fn cycle_focus(a: &mut App, backward: bool) {
    let ids = focus_ids(a);
    if ids.is_empty() {
        return;
    }
    let next = match a.focus {
        None => ids[0],
        Some(cur) => {
            let pos = ids.iter().position(|id| *id == cur).unwrap_or(0);
            let n = ids.len();
            if backward {
                ids[(pos + n - 1) % n]
            } else {
                ids[(pos + 1) % n]
            }
        }
    };
    a.focus = Some(next);
    render_present(a);
}

/// The stage's default action for Enter.
fn primary_id(a: &App) -> Option<i32> {
    let id = match a.stage {
        Stage::Fresh => IDC_INSTALL,
        Stage::UpToDate => IDC_CLOSE,
        Stage::UninstallConfirm => IDC_INSTALL,
        Stage::Done => IDC_LAUNCH,
        Stage::Error => {
            if a.uninstall_mode {
                IDC_CLOSE
            } else {
                IDC_RETRY
            }
        }
        _ => return None,
    };
    if is_focusable(a, id) {
        Some(id)
    } else {
        None
    }
}

fn secondary_id(a: &App) -> Option<i32> {
    let id = match a.stage {
        Stage::UpToDate => IDC_RELEASES,
        Stage::Done | Stage::Error => IDC_CLOSE,
        _ => return None,
    };
    if is_focusable(a, id) {
        Some(id)
    } else {
        None
    }
}

fn ctrl_key_down() -> bool {
    unsafe { (GetKeyState(VK_CONTROL.0 as i32) as u16 & 0x8000) != 0 }
}

fn on_keydown(a: &mut App, vk: u16) {
    if vk == VK_TAB.0 {
        cycle_focus(a, ctrl_key_down());
    } else if vk == VK_RETURN.0 {
        // Enter runs the focused control; the path field defers to the
        // stage's primary action instead.
        let target = match a.focus {
            Some(IDC_PATHEDIT) => primary_id(a),
            Some(id) if is_focusable(a, id) => Some(id),
            _ => primary_id(a),
        };
        if let Some(id) = target {
            activate(a, id);
        }
    } else if vk == VK_SPACE.0 {
        if let Some(id) = a.focus {
            if id != IDC_PATHEDIT && is_focusable(a, id) {
                activate(a, id);
            }
        }
    } else if vk == VK_ESCAPE.0 {
        if let Some(id) = secondary_id(a) {
            activate(a, id);
        } else if !a.busy {
            unsafe {
                let _ = PostMessageW(Some(a.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        }
    } else if vk == 0x56 {
        // Ctrl+V pastes into the path field.
        if a.focus == Some(IDC_PATHEDIT) && ctrl_key_down() {
            if let Some(text) = clipboard_text() {
                a.path.push_str(text.trim());
                a.path = a.path.trim().to_string();
                a.caret_on = true;
                set_text(a, IDC_ERROR, "");
                render_present(a);
            }
        }
    }
}

fn on_char(a: &mut App, ch: u32) {
    if a.focus != Some(IDC_PATHEDIT) {
        return;
    }
    match ch {
        0x08 => {
            // Backspace: drop the last character.
            let mut trimmed = a.path.clone();
            trimmed.pop();
            a.path = trimmed;
        }
        0x0D | 0x1B | 0x09 => return, // handled in on_keydown
        c if c >= 0x20 && c != 0x7F => {
            if let Some(chr) = char::from_u32(c) {
                if a.path.chars().count() < 260 {
                    a.path.push(chr);
                }
            }
        }
        _ => return,
    }
    a.caret_on = true;
    set_text(a, IDC_ERROR, "");
    render_present(a);
}

/// Clears hover/press state once the cursor leaves the window.
fn clear_stale_hover(a: &mut App) {
    unsafe {
        let mut cursor = POINT { x: 0, y: 0 };
        if GetCursorPos(&mut cursor).is_err() {
            return;
        }
        let mut rect = RECT {
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
        };
        if GetWindowRect(a.hwnd, &mut rect).is_err() {
            return;
        }
        let outside = cursor.x < rect.left
            || cursor.x >= rect.right
            || cursor.y < rect.top
            || cursor.y >= rect.bottom;
        if outside && (a.hot.is_some() || a.pressed.is_some()) {
            a.hot = None;
            a.pressed = None;
            let _ = KillTimer(Some(a.hwnd), IDT_HOVER);
            render_present(a);
        }
    }
}

/// Reads CF_UNICODETEXT from the clipboard, if present.
fn clipboard_text() -> Option<String> {
    unsafe {
        if OpenClipboard(None).is_err() {
            return None;
        }
        let mut result = None;
        if let Ok(handle) = GetClipboardData(13 /* CF_UNICODETEXT */) {
            let hglobal = HGLOBAL(handle.0);
            let ptr = GlobalLock(hglobal) as *const u16;
            if !ptr.is_null() {
                let mut len = 0usize;
                while *ptr.add(len) != 0 && len < 8192 {
                    len += 1;
                }
                result = Some(String::from_utf16_lossy(std::slice::from_raw_parts(
                    ptr, len,
                )));
                let _ = GlobalUnlock(hglobal);
            }
        }
        let _ = CloseClipboard();
        result
    }
}

// ------------------------------------------------------------------ actions

fn is_primary(id: i32) -> bool {
    matches!(id, IDC_INSTALL | IDC_LAUNCH | IDC_RETRY)
}

fn activate(a: &mut App, id: i32) {
    debug_log(&format!("activate: id={id} stage={:?}", a.stage));
    match id {
        IDC_CAPCLOSE => unsafe {
            if !a.busy {
                let _ = PostMessageW(Some(a.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
            }
        },
        IDC_BROWSE => {
            let start = PathBuf::from(a.path.clone());
            let picked = shell::pick_folder(a.hwnd, "Select a folder for SUNDAY Launcher", &start);
            if let Some(dir) = picked {
                a.path = dir.to_string_lossy().to_string();
                set_text(a, IDC_ERROR, "");
                render_present(a);
            }
        }
        IDC_INSTALL | IDC_RETRY => {
            if a.uninstall_mode {
                start_uninstall(a);
                return;
            }
            // The one-page form validates inline.
            if a.stage == Stage::Fresh {
                match validate_path(&a.path) {
                    Ok(clean) => a.path = clean,
                    Err(msg) => {
                        set_text(a, IDC_ERROR, msg);
                        return;
                    }
                }
            }
            a.install_dest = PathBuf::from(a.path.clone());
            start_install(a);
            goto_stage(a, Stage::Installing);
        }
        IDC_LAUNCH => {
            let exe = a.install_dest.join(CURRENT_MAIN_BINARY);
            let dir = a.install_dest.clone();
            if shell::launch_app(&exe, &dir) {
                fade_quit(a);
            } else {
                // Never close silently on a failed start: say it in the status
                // line and keep the install folder visible below it, so the
                // user can retry or find SUNDAY Launcher without hunting for it.
                set_text(
                    a,
                    IDC_SUB,
                    "SUNDAY Launcher could not start - use the Start menu or the folder below.",
                );
            }
        }
        IDC_CLOSE | IDC_CANCEL => unsafe {
            let _ = PostMessageW(Some(a.hwnd), WM_CLOSE, WPARAM(0), LPARAM(0));
        },
        IDC_RELEASES => {
            if !shell::open_url("https://github.com/SadinKai/SUNDAY/releases") {
                // No dialog boxes: show the address inline instead.
                set_text(a, IDC_HINT, "github.com/SadinKai/SUNDAY/releases");
            }
        }
        IDC_CHECK_DESKTOP => {
            a.desktop_shortcut = !a.desktop_shortcut;
            if let Some(w) = a.widgets.iter_mut().find(|w| w.id == IDC_CHECK_DESKTOP) {
                if let WgKind::Check { checked, .. } = &mut w.kind {
                    *checked = a.desktop_shortcut;
                }
            }
            render_present(a);
        }
        _ => {}
    }
}

#[cfg(debug_assertions)]
fn demo_advance(a: &mut App) {
    match a.stage {
        Stage::Fresh => {
            activate(a, IDC_INSTALL);
        }
        Stage::UpToDate | Stage::Done => fade_quit(a),
        Stage::UninstallConfirm => activate(a, IDC_CLOSE),
        _ => {}
    }
}

// ------------------------------------------------------------------ worker plumbing

fn start_install(a: &mut App) {
    // Every path that reaches the worker must carry the destination, so the
    // Done page and the launch button can never point at an empty path.
    if a.install_dest.as_os_str().is_empty() {
        a.install_dest = PathBuf::from(a.path.clone());
    }
    let dest = a.install_dest.clone();
    let desktop = a.desktop_shortcut;
    let version = a.version_to_install();
    let launch_after_install = should_launch_after_install(a);
    a.relaunch_ok = None;
    let (tx, rx) = channel::<Msg>();
    a.rx = Some(rx);
    a.busy = true;
    unsafe {
        let _ = SetTimer(Some(a.hwnd), IDT_POLL, 40, None);
    }
    std::thread::spawn(move || {
        match run_install(&dest, desktop, &version, &tx) {
            Ok(()) => {
                // Bring SUNDAY Launcher up from this worker thread, not the window
                // thread: launch_app retries around transient antivirus
                // blocks, and those sleeps must never stall the message loop.
                // Debug demo runs never leave an app behind. Release builds do
                // not compile the demo switch or its timer path at all.
                if launch_after_install {
                    let exe = dest.join(CURRENT_MAIN_BINARY);
                    let ok = shell::launch_app(&exe, &dest);
                    let _ = tx.send(Msg::Relaunched(ok));
                }
                let _ = tx.send(Msg::Done);
            }
            Err(e) => {
                debug_log(&format!("install error: {e}"));
                let _ = tx.send(Msg::Err(e));
            }
        }
    });
}

fn start_uninstall(a: &mut App) {
    let (tx, rx) = channel::<Msg>();
    a.rx = Some(rx);
    a.busy = true;
    set_text(a, IDC_SUB, "Verifying ownership evidence…");
    unsafe {
        let _ = SetTimer(Some(a.hwnd), IDT_POLL, 40, None);
    }
    std::thread::spawn(move || match launch_removal_helper() {
        Ok(()) => {
            let _ = tx.send(Msg::RemovalReady);
        }
        Err(error) => {
            let _ = tx.send(Msg::Err(error));
        }
    });
}

fn poll_worker(a: &mut App) {
    let Some(rx) = a.rx.take() else { return };
    let mut finished: Option<Msg> = None;
    while let Ok(m) = rx.try_recv() {
        match m {
            Msg::File(f) => set_text(a, IDC_FILE, &f),
            Msg::Bytes(done, total) => {
                set_progress(a, done, total);
                set_text(a, IDC_BYTES, &format!("{} of {}", mb(done), mb(total)));
            }
            Msg::Note(n) => set_text(a, IDC_SUB, &n),
            Msg::Relaunched(ok) => a.relaunch_ok = Some(ok),
            Msg::RemovalReady => finished = Some(Msg::RemovalReady),
            Msg::Done => finished = Some(Msg::Done),
            Msg::Err(e) => finished = Some(Msg::Err(e)),
        }
    }
    match finished {
        Some(Msg::Done) | Some(Msg::RemovalReady) | Some(Msg::Err(_)) => {
            let was_error = matches!(finished, Some(Msg::Err(_)));
            unsafe {
                let _ = KillTimer(Some(a.hwnd), IDT_POLL);
            }
            a.busy = false;
            if was_error {
                if let Some(Msg::Err(e)) = finished {
                    a.last_error = e;
                }
                goto_stage(a, Stage::Error);
            } else if matches!(finished, Some(Msg::RemovalReady)) {
                fade_quit(a);
            } else {
                // Land on the done page after installation. Debug demo runs
                // stay quiet so automated audits never leave an app running.
                goto_stage(a, Stage::Done);
                if should_launch_after_install(a) && a.relaunch_ok == Some(false) {
                    debug_log("fresh install: auto-launch failed (the Launch button remains)");
                    set_text(
                        a,
                        IDC_SUB,
                        "SUNDAY Launcher could not start - use the Start menu or the folder below.",
                    );
                }
            }
        }
        _ => {
            a.rx = Some(rx); // still busy
        }
    }
}

fn set_text(a: &mut App, id: i32, text: &str) {
    if let Some(w) = a.widgets.iter_mut().find(|w| w.id == id) {
        if let WgKind::Text { text: t, .. } = &mut w.kind {
            *t = text.to_string();
            render_present(a);
        }
    }
}

fn set_progress(a: &mut App, done: u64, total: u64) {
    a.progress = if total == 0 {
        1.0
    } else {
        (done as f64 / total as f64).clamp(0.0, 1.0) as f32
    };
    render_present(a);
}

// ------------------------------------------------------------------ entry

fn main() {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    if let Some(installation_id) = arguments
        .iter()
        .find_map(|arg| arg.strip_prefix("--uninstall-helper="))
    {
        let parent_pid = arguments
            .iter()
            .find_map(|arg| arg.strip_prefix("--parent-pid="))
            .and_then(|value| value.parse::<u32>().ok());
        let result = parent_pid
            .ok_or_else(|| "Removal helper parent identity is missing.".to_string())
            .and_then(|pid| run_removal_helper(installation_id, pid));
        if let Err(error) = result {
            debug_log(&format!("removal helper failed: {error}"));
            std::process::exit(1);
        }
        std::process::exit(0);
    }
    unsafe {
        let _ = SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

        // GDI+ draws the entire window.
        let mut gptoken: usize = 0;
        let gpinput = GdiplusStartupInput {
            GdiplusVersion: 1,
            DebugEventCallback: 0,
            SuppressBackgroundThread: windows::core::BOOL::default(),
            SuppressExternalCodecs: windows::core::BOOL::default(),
        };
        if GdiplusStartup(&mut gptoken, &gpinput, std::ptr::null_mut()) != Status(0) {
            return;
        }

        let hinst: HINSTANCE = GetModuleHandleW(None).expect("module handle").into();
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);

        let wc = WNDCLASSW {
            style: Default::default(),
            lpfnWndProc: Some(wnd_proc),
            cbClsExtra: 0,
            cbWndExtra: 0,
            hInstance: hinst,
            hIcon: LoadIconW(Some(hinst), PCWSTR(std::ptr::without_provenance(1)))
                .or_else(|_| LoadIconW(None, IDI_APPLICATION))
                .unwrap_or(windows::Win32::UI::WindowsAndMessaging::HICON(
                    std::ptr::null_mut(),
                )),
            hCursor: LoadCursorW(None, IDC_ARROW).unwrap_or_default(),
            hbrBackground: windows::Win32::Graphics::Gdi::HBRUSH(std::ptr::null_mut()),
            lpszMenuName: PCWSTR::null(),
            lpszClassName: w!("SundaySetupWindow"),
        };
        let _ = RegisterClassW(&wc);

        let uninstall = std::env::args().skip(1).any(|arg| {
            let l = arg.to_ascii_lowercase();
            l == "--uninstall" || l == "/uninstall"
        }) || !Package::exists();
        let title = if uninstall {
            UNINSTALL_TITLE
        } else {
            APP_TITLE
        };

        // Borderless layered window: the shape comes from our alpha channel.
        let hwnd = CreateWindowExW(
            WS_EX_LAYERED,
            w!("SundaySetupWindow"),
            PCWSTR(to_wide(title).as_ptr()),
            WS_POPUP,
            CW_USEDEFAULT,
            CW_USEDEFAULT,
            WIN_W,
            WIN_H,
            None,
            None,
            Some(hinst),
            None,
        )
        .unwrap_or(HWND(std::ptr::null_mut()));
        if hwnd.0.is_null() {
            return;
        }

        if let Some(a) = app_from(hwnd) {
            size_window(a);
            rebuild_canvas(a);
            build_stage(a);
            // Draw once at zero opacity, show, then fade in.
            canvas_present(a, 0);
            let _ = ShowWindow(hwnd, SW_SHOW);
            start_fade(a, 255, 350, After::None);
        }

        let mut msg = MSG::default();
        loop {
            let r = GetMessageW(&mut msg, None, 0, 0);
            if r.0 <= 0 {
                break;
            }
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }
}
