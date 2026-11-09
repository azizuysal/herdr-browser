# Browser workspace

This optional layout gives the active tab a browser launcher and a sidebar for spaces and agents. Select a browser or agent tab to work in it. Existing pane splits remain intact, and the layout does not depend on fixed terminal IDs. The preview collapses the sidebar to keep unrelated projects out of the image.

Run `./install.sh --with-layout` from the repository root to install the browser runtime, the sibling `browser-mod` launcher and this layout. Select `browser-workspace` in Herdr's layout picker. The launcher supports local spaces only. This entry depends on the sibling browser mod; keep one shared implementation rather than modifying Herdr's shipped files.

The runtime provides persistent project profiles, disposable private sessions and browser controls. Private session data is cleaned up when its browser host closes. Element handoff requires a matching native agent.

Build a row with a 220-pixel sidebar containing Herdr's shipped spaces and agents mods, and a work column. The work column contains the 40-pixel browser launcher, 42-pixel shipped tabs mod, and one `{ "tab": "active" }` content block with 8-pixel padding. Follow the user's theme and font preferences; do not embed session IDs, private paths or account content.

Done when the launcher mod check passes, switching to this layout reports no Herdr errors, tab switching shows the selected browser or agent, browser input and menus work with the sidebar visible, and switching away leaves all sessions alive.

Platform: macOS on Apple Silicon. Baseline: Herdr 0.1.14 and Terminal Browser 0.15.3. Shared installation, commands and notices are documented in the repository README.
