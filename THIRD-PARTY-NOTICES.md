# Third-party software

This is an independent integration for Herdr, not an official Herdr or Terminal Browser release.

The installer downloads [Terminal Browser v0.15.3](https://github.com/zenbu-labs/terminal-browser/releases/tag/v0.15.3), including its Electron runtime, from the upstream release. It verifies the SHA-256 digest in `runtime-lock.json` before extraction. Runtime binaries are not stored in this repository.

Terminal Browser and its Pixel engine are Copyright 2026 Zenbu Labs, Inc. Their MIT license notices are preserved in `licenses/terminal-browser.txt` and `licenses/pixel.txt`, and copied into each installation. The native grid patch changes Pixel's full-frame image placement for native Herdr. The JavaScript patches add cookie flushing, native agent handoff and in-page DevTools menus.

Electron and Chromium notices remain in the upstream application bundle. The installer does not modify the signed Electron bundle. Rust dependency versions and licenses remain governed by the upstream source and lockfile used for the native build.

Herdr is separately installed and licensed under Apache-2.0. The workspace references its shipped mods; it does not redistribute their source.
