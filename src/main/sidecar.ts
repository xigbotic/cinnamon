import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { app } from "electron";
import type { SidecarEvent, TransportCommand } from "../../shared/types";

/**
 * Spawns and supervises the SMTC sidecar, parsing its newline-delimited JSON
 * output and exposing a typed event stream plus a command channel.
 *
 * Packaged builds run a standalone PyInstaller exe (no Python needed); dev runs
 * the .py through a local Python interpreter.
 */
export class Sidecar {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private handlers = new Set<(e: SidecarEvent) => void>();

  constructor(private command: string, private args: string[]) {}

  start() {
    if (!existsSync(this.command)) {
      throw new Error(`sidecar executable not found: ${this.command}`);
    }
    this.proc = spawn(this.command, this.args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const rl = createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: SidecarEvent;
      try {
        event = JSON.parse(trimmed);
      } catch {
        return;
      }
      for (const h of this.handlers) h(event);
    });

    this.proc.stderr.on("data", (d) =>
      console.error("[sidecar stderr]", d.toString().trim())
    );
    this.proc.on("exit", (code) =>
      console.error(`[sidecar] exited with code ${code}`)
    );
  }

  get running(): boolean {
    return !!this.proc && this.proc.exitCode === null && !this.proc.killed;
  }

  on(handler: (e: SidecarEvent) => void) {
    this.handlers.add(handler);
  }

  send(cmd: TransportCommand) {
    this.proc?.stdin.write(JSON.stringify(cmd) + "\n");
  }

  stop() {
    this.proc?.kill();
    this.proc = null;
  }
}

/**
 * Resolves how to launch the sidecar:
 *  - packaged: the bundled PyInstaller exe (no Python on the machine required)
 *  - dev: a local Python interpreter running the .py script
 */
export function resolveSidecar(pythonPath: string): {
  command: string;
  args: string[];
} {
  if (app.isPackaged) {
    const exe = join(process.resourcesPath, "sidecar", "smtc_helper.exe");
    return { command: exe, args: [] };
  }
  // Dev: prefer the compiled exe if it's been built, else run via Python.
  const appRoot = app.getAppPath();
  const exe = join(appRoot, "resources", "sidecar", "smtc_helper.exe");
  if (existsSync(exe)) return { command: exe, args: [] };
  return { command: pythonPath, args: [join(appRoot, "sidecar", "smtc_helper.py")] };
}
