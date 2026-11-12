import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { errMessage } from "./errors";
import type { DailyUsage, ModelBreakdown } from "./usage";

// Raw breakdown shape from `agentsview usage daily --json`. Token counters
// may be omitted (agentsview elides zeros) and totalTokens is always
// computed downstream — this is the wire shape, not the internal one.
// Kept private to this module: only parseAgentsviewOutput sees it.
interface RawModelBreakdown {
  modelName: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  cost?: number;
  source?: string;
}

// Raw shape we accept from `agentsview usage daily --json`. Tolerant on
// purpose — agentsview occasionally omits the modelBreakdowns array on
// empty days.
interface RawDailyEntry {
  date: string;
  modelBreakdowns?: RawModelBreakdown[];
}

// Resolve agentsview binary — launchd/systemd don't inherit user shell PATH,
// so we can't rely on execvp's default search. Resolution order:
//   1. $AGENTSVIEW_BIN (explicit override for nix, asdf, custom installs)
//   2. Hard-coded install-location candidates (matches the quickstart)
//   3. $PATH (covers interactive runs)
// agentsview ships a native binary: `agentsview.exe` on Windows (its installer
// drops it in %USERPROFILE%\.agentsview\bin and adds that dir to PATH), bare
// `agentsview` elsewhere. We deliberately don't probe `.cmd`/`.bat` shims — the
// installer never writes one, and execFileSync can't run a command shim on
// Windows without a shell, so resolving to one would only hand the caller a
// path it can't exec. Parameterized over { platform, env, isExecutable } (with
// target-platform path semantics) so the Windows branch is testable on any host.
interface ResolveDeps {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isExecutable: (p: string) => boolean;
}

function uniqueDefined(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function isExecutableFile(p: string): boolean {
  try {
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch { return false; }
}

function pathFor(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function binaryName(platform: NodeJS.Platform): string {
  return platform === "win32" ? "agentsview.exe" : "agentsview";
}

function agentsviewCandidates(deps: ResolveDeps): string[] {
  const p = pathFor(deps.platform);
  const name = binaryName(deps.platform);
  const candidates: string[] = [];
  for (const home of uniqueDefined([deps.env.HOME, deps.env.USERPROFILE])) {
    candidates.push(p.join(home, ".local", "bin", name));
    candidates.push(p.join(home, ".agentsview", "bin", name));
  }
  candidates.push("/opt/homebrew/bin/agentsview", "/usr/local/bin/agentsview");
  return uniqueDefined(candidates);
}

function resolveFromPath(deps: ResolveDeps): string | null {
  const p = pathFor(deps.platform);
  const name = binaryName(deps.platform);
  // process.env is case-insensitive on Windows, so PATH already resolves a
  // `Path`/`path`-cased var (production passes process.env; tests inject PATH).
  const pathValue = deps.env.PATH || "";
  for (const dir of pathValue.split(p.delimiter)) {
    if (!dir) continue;
    const candidate = p.join(dir, name);
    if (deps.isExecutable(candidate)) return candidate;
  }
  return null;
}

export function resolveAgentsviewWith(deps: ResolveDeps): string | null {
  const override = deps.env.AGENTSVIEW_BIN;
  if (override && deps.isExecutable(override)) return override;
  for (const candidate of agentsviewCandidates(deps)) {
    if (deps.isExecutable(candidate)) return candidate;
  }
  return resolveFromPath(deps);
}

export function resolveAgentsview(): string | null {
  return resolveAgentsviewWith({
    platform: process.platform,
    env: process.env,
    isExecutable: isExecutableFile,
  });
}

// Parses `agentsview --version` raw output like
//   "agentsview v0.23.0-2-g1b484fb (commit 1b484fb, built 2026-04-19T00:00:00Z)"
// into the bare git-describe core ("0.23.0" / "0.23.0-2-g1b484fb"). The
// server's MIN-version gate compares the leading X.Y.Z, so the wrapper
// prefix and "(commit …, built …)" tail are dropped to keep the wire
// value compact and directly displayable. Returns null if the binary is
// missing or `--version` fails.
export function detectAgentsviewVersion(bin: string | null, timeoutMs: number = 5000): string | null {
  if (!bin) return null;
  let raw: string;
  try {
    raw = execFileSync(bin, ["--version"], {
      encoding: "utf-8",
      timeout: timeoutMs,
    }).trim();
  } catch (err) {
    console.error(`  agentsview --version failed: ${errMessage(err)}`);
    return null;
  }
  const m = raw.match(/v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/);
  return m ? m[1] : null;
}

export function toIsoDate(sinceStr: string): string {
  return `${sinceStr.slice(0, 4)}-${sinceStr.slice(4, 6)}-${sinceStr.slice(6, 8)}`;
}

interface AgentsviewJson {
  daily?: RawDailyEntry[];
}

// Convert `agentsview usage daily --json` output into the normalized
// internal shape. Defaults missing per-token-type counters to 0 and
// computes totalTokens once, so downstream code (merge.ts / report.ts)
// can rely on every counter being a finite number.
export function parseAgentsviewOutput(parsed: AgentsviewJson, source: string): DailyUsage[] {
  const daily = parsed.daily || [];
  return daily.map((day) => {
    const modelBreakdowns: ModelBreakdown[] = (day.modelBreakdowns || []).map((m) => {
      const inputTokens = m.inputTokens || 0;
      const outputTokens = m.outputTokens || 0;
      const cacheCreationTokens = m.cacheCreationTokens || 0;
      const cacheReadTokens = m.cacheReadTokens || 0;
      return {
        modelName: m.modelName,
        inputTokens,
        outputTokens,
        cacheCreationTokens,
        cacheReadTokens,
        totalTokens: inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens,
        cost: m.cost,
        source,
      };
    });
    return { date: day.date, modelBreakdowns };
  });
}

// agentsview's syncing pass (no --no-sync) runs its full parser registry,
// including a Warp parser that reads Warp's sqlite from a macOS App Group
// Container (~/Library/Group Containers/2BBY89MBSN.dev.warp/.../warp.sqlite).
// An unattended launchd/systemd daemon has no Full Disk Access, so that
// open() *blocks* (rather than failing fast) until the timeout, killing the
// run before it can POST. We only report Claude+Codex, so syncing calls point
// WARP_DIR at an always-empty dir: the parser finds no warp.sqlite there and
// skips Warp. --no-sync passes don't run the parser, so they're untouched.
// Living on the query (not the OS-unit env) means existing installs get the
// fix on a plain `npm install` rebuild, with no daemon-unit regeneration.
const WARP_SKIP_DIR = "/var/empty";

function queryAgent(
  bin: string,
  since: string,
  agent: string,
  noSync: boolean,
  timeoutMs: number,
  extraEnv?: Record<string, string>,
): DailyUsage[] {
  const args = ["usage", "daily", "--json", "--breakdown", "--agent", agent, "--since", since];
  if (noSync) args.push("--no-sync");
  const execOpts: Parameters<typeof execFileSync>[2] = { encoding: "utf-8", timeout: timeoutMs };
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (!noSync) env.WARP_DIR = WARP_SKIP_DIR;
  execOpts.env = env;
  let raw: string;
  try {
    raw = execFileSync(bin, args, execOpts) as string;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    const detail = stderr ? `: ${stderr}` : `: ${errMessage(err)}`;
    throw new Error(`agentsview ${agent} query failed${detail}`);
  }
  return parseAgentsviewOutput(JSON.parse(raw), agent);
}

export function collectAgentsviewUsage(bin: string, sinceStr: string, timeoutMs: number = 180000): { claudeDaily: DailyUsage[]; codexDaily: DailyUsage[] } {
  const since = toIsoDate(sinceStr);

  // One direct sync covers every agent (agentsview's syncAllLocked walks the
  // whole parser registry), then both reads skip sync. A syncing read instead
  // hands the sync to the freshly auto-started daemon, which first runs its full
  // startup reconciliation (~5k files: minutes of CPU on a busy Mac, measured
  // 2.5 min) before answering. AGENTSVIEW_NO_DAEMON makes `sync` write
  // in-process and exit. Best effort: on failure we report the last snapshot.
  try {
    execFileSync(bin, ["sync"], {
      env: { ...process.env, AGENTSVIEW_NO_DAEMON: "1", WARP_DIR: WARP_SKIP_DIR },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim() || "";
    console.error(`  agentsview sync skipped (${stderr || errMessage(err)}); reading last-synced data`);
  }
  const claudeDaily = queryAgent(bin, since, "claude", true, timeoutMs);
  const codexDaily = queryAgent(bin, since, "codex", true, timeoutMs);

  return { claudeDaily, codexDaily };
}

// Single-agent (Claude) collection against an isolated agentsview data
// dir + projects dir. Used for EXTRA_CLAUDE_CONFIGS entries where we
// want per-remote-dir incremental sync without contaminating the local
// machine's ~/.agentsview/sessions.db.
export function collectAgentsviewClaudeOnly(bin: string, sinceStr: string, env: Record<string, string>, timeoutMs: number = 180000): DailyUsage[] {
  const since = toIsoDate(sinceStr);
  return queryAgent(bin, since, "claude", false, timeoutMs, env);
}

// agentsview reads silently auto-start a background `serve` daemon that
// outlives this process and re-syncs every session file on each change: ~1 core
// for minutes while it catches up (after a boot or a fresh install), ~0.2 core
// forever after on a Mac full of busy agents. A scheduled reporter only needs it
// for its own reads, so stop it on exit -- unless one was already running before
// we started, which is the user's to keep.
export function stopAgentsviewDaemonOnExit(bin: string): void {
  let status: string;
  try {
    status = execFileSync(bin, ["daemon", "status"], {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return; // can't tell who owns a daemon: leave everything as is
  }
  if (!status.includes("No agentsview daemon is running")) return;
  // Signals skip "exit" handlers; launchd SIGTERMs us on unload. An orphan left
  // there would look like the user's daemon to every later run.
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGINT", () => process.exit(130));
  process.on("exit", () => {
    try {
      // `daemon stop` = SIGTERM, a 10s grace, then SIGKILL; a busy daemon
      // takes ~16s. A shorter timeout kills the stop itself, the daemon
      // survives, and the next run then mistakes it for the user's.
      execFileSync(bin, ["daemon", "stop"], { stdio: "ignore", timeout: 60000 });
    } catch {
      // best effort: the next run tries again
    }
  });
}
