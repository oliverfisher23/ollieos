fn main() {
    // The address of the published OllieOS app is baked in at build time.
    println!("cargo:rerun-if-env-changed=OLLIEOS_URL");
    match std::env::var("OLLIEOS_URL") {
        Ok(v) if v.starts_with("https://") => {}
        // Local testing only, e.g. against `pnpm --filter @workspace/api-server run dev`.
        Ok(v) if v.starts_with("http://localhost") || v.starts_with("http://127.0.0.1") => {}
        Ok(v) => panic!("OLLIEOS_URL must start with https:// (got {v:?})"),
        Err(_) => panic!(
            "OLLIEOS_URL is not set. Build with the published app's address, e.g.\n  \
             OLLIEOS_URL=https://your-app.replit.app cargo tauri build"
        ),
    }
    tauri_build::build()
}
