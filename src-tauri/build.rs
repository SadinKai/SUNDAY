fn main() {
    println!("cargo:rerun-if-env-changed=SUNDAY_RELEASE_PUBLIC_KEY_SPKI_B64");
    println!("cargo:rerun-if-env-changed=SUNDAY_RELEASE_PUBLISHER");
    println!("cargo:rerun-if-env-changed=SUNDAY_RELEASE_MANIFEST_URL");
    tauri_build::build()
}
