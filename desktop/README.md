# OllieOS for macOS

A native Mac app for OllieOS, built with [Tauri v2](https://v2.tauri.app). It is a window onto the **published** OllieOS app: the server, database, sign-in, connectors and MCP all stay on Replit. Nothing here changes how the web app or Claude's connector works.

## What it does today

- Opens OllieOS in its own window with a Dock icon, and remembers the window's size and position.
- Shows a "Can't reach OllieOS" screen with Try again when the server or the network is down, and retries on its own.
- Opens links that would open a new tab (Gmail, sources, documents, research sites) in your default browser. OllieOS links stay in the app. `mailto:` and other app links go to macOS.
- Go menu: Home (⇧⌘H), Back (⌘[), Forward (⌘]), Reload (⌘R), Open This Page in Browser (⇧⌘O). The standard Edit menu gives copy, paste and undo.
- Asks for the microphone when voice capture is used.

Sign-in works the same as in a browser: you sign in with Replit inside the window once, and the session lasts 7 days.

## Build it on GitHub (no tools needed on your Mac)

1. In GitHub, open the repository's **Settings**, then **Secrets and variables**, then **Actions**, then the **Variables** tab. Add a variable named `OLLIEOS_URL` set to the published address, for example `https://your-app.replit.app` (no trailing path).
2. Open **Actions**, choose **Build Mac app**, and click **Run workflow**. It also runs on its own when `desktop/` changes on `main`.
3. When it finishes (about 10 to 15 minutes the first time), download **OllieOS-macOS** from the run, unzip it and open the `.dmg`. Drag OllieOS to Applications.
4. The first time you open it, macOS will say it can't check the developer, because the app is not signed with an Apple Developer ID. Open **System Settings**, then **Privacy & Security**, scroll down and click **Open Anyway**. You only do this once per download.

## Build it on your Mac

You need the Xcode command line tools and Rust:

```bash
xcode-select --install
```

```bash
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
```

Then, from this folder:

```bash
cd src-tauri && OLLIEOS_URL=https://your-app.replit.app npx --yes @tauri-apps/cli@2.12.4 build
```

The app is in `src-tauri/target/release/bundle/macos/OllieOS.app` and the installer in `src-tauri/target/release/bundle/dmg/`. A build made on your own Mac opens without the Gatekeeper step.

To try changes without building an installer, run the app straight away:

```bash
cd src-tauri && OLLIEOS_URL=https://your-app.replit.app npx --yes @tauri-apps/cli@2.12.4 dev
```

`OLLIEOS_URL` can also point at a local server (`http://localhost:...`) for testing.

## Where things live

| Path | What it is |
|---|---|
| `src-tauri/src/lib.rs` | The window, link rules and Go menu |
| `src-tauri/build.rs` | Reads `OLLIEOS_URL` at build time and refuses to build without it |
| `src-tauri/tauri.conf.json` | App name, bundle id (`com.ollieos.desktop`), icons, ad-hoc signing |
| `src-tauri/Info.plist` | The microphone permission message |
| `src-tauri/icons/` | App icons, made from `app-icon.svg` with `npx @tauri-apps/cli@2.12.4 icon icons/app-icon.svg` |
| `loading/index.html` | The bundled screen shown while OllieOS opens or when it can't be reached |
| `../.github/workflows/desktop-macos.yml` | The GitHub build |

This folder is not part of the pnpm workspace, so Replit and `pnpm install` ignore it.

## Known limits

- **Signing in with Google may not work in the window.** Google blocks sign-in inside embedded browsers. Sign in to Replit with email and password (or another method) instead. If that is not possible, the fix is a small "hand the session over from Safari" step in the server.
- **Downloads are blocked for now.** Nothing in OllieOS downloads files today; when CSV export arrives, the app needs a download handler.
- **Not signed or notarised.** Fine for one person. Sharing it more widely needs an Apple Developer account ($99 a year) and a signing step in the workflow.

## Next steps

1. A `/quick-add` page in the web app, opened by a global hotkey in a small floating window (it shares the main window's sign-in).
2. A menu bar icon and Dock badge with the Inbox count.
3. Native notifications for the digest and upcoming meeting briefs.
