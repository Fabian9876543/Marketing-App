import { spawn, type ChildProcess } from "node:child_process";

/**
 * Hält den Mac wach (verhindert Ruhezustand bei Inaktivität), solange ein Post
 * gleich fällig ist oder hochgeladen wird. Zugeklappte Laptops schlafen trotzdem –
 * verpasste Posts holt der Worker innerhalb der Toleranz nach.
 */
export class KeepAwake {
  private child: ChildProcess | null = null;

  set(on: boolean): void {
    if (process.platform !== "darwin") return;
    if (on && !this.child) {
      this.child = spawn("caffeinate", ["-i", "-w", String(process.pid)], { stdio: "ignore" });
      this.child.on("exit", () => (this.child = null));
      this.child.on("error", () => (this.child = null));
    } else if (!on && this.child) {
      this.child.kill();
      this.child = null;
    }
  }
}
