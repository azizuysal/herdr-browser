import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { exec, focused, home, props, spaces, theme } from "herdr";
import { executable as installedExecutable } from "./installation.js";

export default class BrowserLauncher extends View {
  init() {
    this.error = "";
    this.busy = false;
  }

  launch(privateMode, cx) {
    const focus = focused();
    const space = spaces().find((item) => item.id === focus?.space);
    if (!space || space.machine) {
      this.error = space ? "Browser is available only for local spaces." : "Select a local space first.";
      cx.notify();
      return;
    }
    const folder = focus?.cwd || space.folder;
    if (!folder) {
      this.error = "The selected space has no project folder.";
      cx.notify();
      return;
    }
    this.busy = true;
    this.error = "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const executable = props()?.executable || installedExecutable || `${home()}/.local/bin/herdr-browser`;
        const args = ["open", "--project", folder];
        if (privateMode) args.push("--private");
        const result = await exec(executable, args, { cwd: folder, timeout: 60000 });
        if (result.code !== 0) throw new Error(result.stderr.trim() || `Browser exited with code ${result.code}.`);
      } catch (error) {
        this.error = `Could not open browser: ${String(error.message || error)}`;
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
  }

  render() {
    const t = theme();
    const focus = focused();
    const space = spaces().find((item) => item.id === focus?.space);
    const disabled = this.busy || !space || !!space.machine;
    const button = (id, label, privateMode) => div().id(id).px(10).py(5).rounded(5)
      .bg(t.raised).text_color(disabled ? t.dim : t.foreground)
      .when(!disabled, (el) => el.hover((style) => style.bg(t.hover))
        .on_click((_event, cx) => this.launch(privateMode, cx)))
      .child(label);
    const status = this.error || (space?.machine ? "Browser is available only for local spaces." : "");
    return h_flex().size_full().items_center().gap(8).px(10).bg(t.chrome).text_size(12)
      .child(button("browser-open", "Browser", false))
      .child(button("browser-private", "Private", true))
      .child(div().text_color(this.error ? t.blocked : t.muted).truncate().child(status));
  }
}
