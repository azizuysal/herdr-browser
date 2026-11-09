# Herdr Browser

A Chromium browser inside Herdr, with persistent project profiles, private test sessions, DevTools and page-element handoff to Codex or Claude Code.

This repository contains two independently selectable gallery entries:

| Entry | What it adds |
| --- | --- |
| [Browser mod](browser-mod/RECIPE.md) | Browser and Private buttons in your current layout |
| [Browser workspace](browser-workspace/RECIPE.md) | An optional layout with a browser launcher, project sidebar and active tab |

Both use the same runtime and installer. This is an independent integration built on [Terminal Browser](https://github.com/zenbu-labs/terminal-browser) and [Herdr](https://herdr.dev/).

## Install

The initial release supports **Apple Silicon macOS**. Install Herdr and its `hc` core first, plus Node.js 22 or newer, Xcode command-line tools and Rust 1.97.1 through rustup. The native patch is built locally, so installation needs a compiler and can take several minutes. No global packages or agent settings are installed by this script.

Clone the repository, then install:

```sh
git clone https://github.com/azizuysal/herdr-browser.git
cd herdr-browser
./install.sh
```

To include the optional workspace layout:

```sh
./install.sh --with-layout
```

The installer verifies pinned upstream archives, applies the JavaScript fixes, tests and builds the native patch, and then installs the runtime and mod. It leaves your layout selection, keybindings and existing browser profiles alone. It refuses to overwrite any existing runtime, launcher, mod or layout. Updating an earlier installation requires a separate migration; do not delete its profiles to make the installer proceed.

Default destinations:

- Runtime and project profiles: `~/.local/share/herdr-browser/`
- Command: `~/.local/bin/herdr-browser`
- Settings: `~/.config/herdr-browser/`
- Mod: `~/.config/herdr-app/mods/herdr-browser/`
- Optional layout: `~/.config/herdr-app/layouts/browser-workspace.json`

Herdr loads the mod automatically. Use its **Browser** or **Private** button from a local project space. Select **browser-workspace** in the layout picker to use the optional arrangement. Its sidebar lists spaces and agents, and its main area shows the selected tab with any existing pane splits.

Run `./install.sh --help` for separate installation directories and local archive options. The installer records the Node executable it used in the launcher; reinstall into a separate location if that executable moves.

## Project profiles

Git repositories and their linked worktrees share one browser profile. Unrelated repositories use separate cookies, local storage and caches. A non-Git folder requires an explicit `--project` argument; the mod supplies the current folder for you. There is no global profile fallback and no import from other browsers.

Optional `~/.config/herdr-browser/projects.json` groups related components:

```json
{
  "projects": [
    { "id": "product", "root": "/path/to/product", "name": "Product" },
    { "id": "web", "root": "/path/to/product/web", "context_group": "product", "git_common_dir": "/path/to/product/web/.git" }
  ]
}
```

Use real absolute directories. `git_common_dir` makes linked worktrees of that component use the group too. Obtain it with `git rev-parse --path-format=absolute --git-common-dir`. The file is optional; no private registry or external service is required. Set `HERDR_BROWSER_CONFIG_DIR` when calling the installer to choose another configuration directory.

Private sessions start empty and remove their browser profile after their final page or host closes. A macOS cleanup job survives terminal closure; stale sessions are reaped on the next invocation after a restart. Downloads, screenshots, terminal scrollback and agent transcripts are outside this cleanup. Private mode is not network anonymity or memory-only storage.

## Agent control

Run commands from the project's folder. Keep the browser and page IDs returned by `open`:

```sh
herdr-browser open http://localhost:3000 --private
herdr-browser ls --json
herdr-browser action --browser BROWSER_ID --tab TAB_ID -- snapshot
herdr-browser action --browser BROWSER_ID --tab TAB_ID -- click @e3
herdr-browser action --browser BROWSER_ID --tab TAB_ID done
herdr-browser close --browser BROWSER_ID --tab TAB_ID
```

Use references from a fresh snapshot. Every action requires both IDs and rejects browsers belonging to other projects. `close` closes only the named page; the host ends when its final page closes. Commands within a project are serialized, but agents must still coordinate changes to shared websites. Codex must use its normal escalation flow to run the browser outside the command sandbox.

The element-selection control in the browser toolbar pastes an element's description and screenshot path into a live Codex or Claude Code input in the same project. It does not press Enter. Multiple agents require an explicit binding:

```sh
herdr-browser bind --browser BROWSER_ID --terminal TERMINAL_ID
```

Stale bindings, shells, other projects and agents awaiting approval are rejected. Open DevTools from the browser's three-dot menu or with F12 / Cmd+Shift+I.

## Runtime and verification

`runtime-lock.json` pins Terminal Browser 0.15.3 and archive hashes. Herdr 0.1.14 is the integration baseline. The patches preserve project cookies, connect native agent handoff, align fractional-cell pointer coordinates and render DevTools menus inside the browser frame. The signed Electron application bundle is unchanged. Runtime telemetry, crash reporting, update checks and search suggestions are disabled by default.

```sh
mise exec -- npm test
mise exec -- npm run check
herdr-app check browser-mod/mods/herdr-browser
```

The installer also runs the native grid-placement regression tests before building. `tests/live-isolation.mjs` and `tests/devtools-menu.mjs` exercise a separate installed runtime; their instructions are at the top of each file. They require native Herdr access and create only task-owned local test pages. Never substitute a shared user session for a disposable test browser.

## Gallery

Each entry has its own `RECIPE.md` and `preview.png`. The mod entry has no `layouts/` folder; the workspace entry contains its layout and names the shared mod dependency. For publication, use a public GitHub repository with both `herdr-mod` and `herdr-layout` topics. See [Herdr's submission instructions](https://herdr.dev/gallery/).

The repository contains source, patches and sanitized previews only. Runtime binaries, browser profiles, cookies and session records are excluded. See [third-party notices](THIRD-PARTY-NOTICES.md) for upstream attribution.
