# Browser launcher

Add Browser and Private buttons to an existing Herdr layout without replacing its menus or keybindings. The launcher opens a browser for the focused folder in the active local space. Remote spaces are not supported. Errors appear in the strip.

Run `./install.sh` from the repository root to install the browser runtime and this mod. Herdr docks the 40-pixel strip at the bottom when it first sees it; existing layouts can also place `herdr-browser` as a block. Use the user's theme colors. Browser and Private buttons must become disabled while launching, and errors must appear in the strip. The default executable is `~/.local/bin/herdr-browser`; the installer writes `installation.js` for a custom path, and a layout can provide an `executable` prop for testing.

The runtime provides persistent project profiles, disposable private sessions and browser controls. Private session data is cleaned up when its browser host closes. Element handoff requires a matching native agent.

Build from `gpui-kit` View/div, `gpui-base` h_flex and Herdr's focused/spaces/exec/theme APIs. Invoke the shared launcher with `open --project <focused cwd or local space folder>` and add `--private` for the second button. Pass arguments as an array. Do not replace menus, keys, user settings or shipped mods. Keep the runtime's checksummed installer and patches; the engine is an external dependency, not a webview supplied by the mod API.

Done when the native mod check passes; both buttons open the intended local project's browser; a private session starts empty and is cleaned on close; runtime errors are visible; and the user's existing layout and sessions remain intact.

Platform: macOS on Apple Silicon. Baseline: Herdr 0.1.14 and Terminal Browser 0.15.3. Shared build, profile rules, commands and notices are documented in the repository README.
