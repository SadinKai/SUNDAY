//! Quarantined identity values for validating and migrating installations made
//! before SUNDAY became the canonical product name. Nothing in this module is
//! used to create a new installation.

pub const PRODUCT_NAME: &str = "Fleet";
pub const MAIN_BINARY: &str = "Fleet.exe";
pub const INSTALL_MANIFEST: &str = "fleet-install-manifest.json";
pub const LEDGER_NAME: &str = ".fleet-install-ledger.json";
pub const UNINSTALL_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Fleet";
pub const MANUFACTURER_KEY: &str = "Software\\Toluwa\\Fleet";
pub const START_MENU_FOLDER: &str = "Fleet";
pub const SHORTCUT_NAME: &str = "Fleet.lnk";

pub fn is_product(value: &str) -> bool {
    value == PRODUCT_NAME
}
