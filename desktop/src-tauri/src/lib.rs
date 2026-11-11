//! OllieOS for macOS.
//!
//! A native window onto the published OllieOS app. The server, database, sign-in,
//! connectors and MCP all stay on Replit; this app only adds a proper Mac window,
//! a Go menu, and sensible link handling.
//!
//! Link rules:
//! - Pages open in the window as normal, including Replit's sign-in pages, so the
//!   session cookie belongs to OllieOS's own domain exactly as it does in a browser.
//! - Anything that asks for a new tab or window (`target="_blank"`, `window.open`)
//!   opens in the default browser, unless it is an OllieOS page, which opens here.
//! - Links that are not web pages (`mailto:`, `slack:` and so on) go to macOS.

use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    webview::NewWindowResponse,
    AppHandle, Manager, Url, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_opener::OpenerExt;

/// The published OllieOS address, set at build time (see build.rs).
const APP_URL: &str = env!("OLLIEOS_URL");
const MAIN_WINDOW: &str = "main";

fn app_url() -> Url {
    Url::parse(APP_URL).expect("OLLIEOS_URL is not a valid URL")
}

fn is_ollieos(url: &Url) -> bool {
    url.origin() == app_url().origin()
}

/// Schemes the window can show itself. Everything else is handed to macOS.
fn is_web(url: &Url) -> bool {
    matches!(
        url.scheme(),
        "https" | "http" | "tauri" | "about" | "data" | "blob"
    )
}

fn open_outside(app: &AppHandle, url: &Url) {
    if let Err(e) = app.opener().open_url(url.as_str(), None::<&str>) {
        eprintln!("Could not open {url} outside OllieOS: {e}");
    }
}

fn main_window(app: &AppHandle) -> Option<tauri::WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn build_main_window(app: &AppHandle) -> tauri::Result<()> {
    let nav_app = app.clone();
    let new_window_app = app.clone();

    // The bundled loading page reads the address from here, checks the server is
    // reachable, then moves on to OllieOS. Only defined on the bundled page.
    let init = format!(
        "if (location.protocol === 'tauri:' || location.hostname === 'tauri.localhost') {{ \
           window.__OLLIEOS_URL__ = \"{}\"; }}",
        app_url().as_str()
    );

    WebviewWindowBuilder::new(app, MAIN_WINDOW, WebviewUrl::App("index.html".into()))
        .title("OllieOS")
        .inner_size(1280.0, 840.0)
        .min_inner_size(420.0, 600.0)
        .initialization_script(&init)
        .on_navigation(move |url| {
            if is_web(url) {
                return true;
            }
            open_outside(&nav_app, url);
            false
        })
        .on_new_window(move |url, _features| {
            if is_ollieos(&url) {
                if let Some(w) = main_window(&new_window_app) {
                    let _ = w.navigate(url);
                }
            } else {
                open_outside(&new_window_app, &url);
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // Start from the standard Mac menu (OllieOS, File, Edit, View, Window, Help) so
    // copy, paste, undo and full screen all work, then add a Go menu before Window.
    let menu = Menu::default(app)?;

    let go = Submenu::with_items(
        app,
        "Go",
        true,
        &[
            &MenuItem::with_id(app, "home", "Home", true, Some("CmdOrCtrl+Shift+H"))?,
            &MenuItem::with_id(app, "back", "Back", true, Some("CmdOrCtrl+["))?,
            &MenuItem::with_id(app, "forward", "Forward", true, Some("CmdOrCtrl+]"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?,
            &MenuItem::with_id(
                app,
                "open-in-browser",
                "Open This Page in Browser",
                true,
                Some("CmdOrCtrl+Shift+O"),
            )?,
        ],
    )?;

    let position = menu.items()?.len().saturating_sub(2);
    menu.insert(&go, position)?;
    Ok(menu)
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(w) = main_window(app) else { return };
    let result = match id {
        "home" => w.navigate(app_url()),
        "back" => w.eval("history.back()"),
        "forward" => w.eval("history.forward()"),
        "reload" => w.reload(),
        "open-in-browser" => {
            if let Ok(url) = w.url() {
                if is_ollieos(&url) {
                    open_outside(app, &url);
                } else {
                    open_outside(app, &app_url());
                }
            }
            Ok(())
        }
        _ => Ok(()),
    };
    if let Err(e) = result {
        eprintln!("Menu action {id} failed: {e}");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        // Remembers the window's size and position between launches.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .menu(build_menu)
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .setup(|app| {
            build_main_window(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running OllieOS");
}
