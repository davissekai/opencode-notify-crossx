/**
 * opencode notification plugin — pings you when a run finishes or input is needed
 *
 * - session.idle      → "Run complete"  (done with a run)
 * - session.error     → "Run failed"
 * - permission.ask / permission.updated → "Input needed"
 *
 * Cross-platform:
 *  macOS: osascript + afplay
 *  Linux: notify-send + paplay
 *  WSL  : PowerShell toast + SystemSounds
 *  fallback: terminal bell (\x07)
 *
 * Focus-aware: only notifies when terminal is not frontmost (when you're away)
 *
 * Only ONE plugin function is exported on purpose: opencode registers every
 * exported function, so aliases would make every notification fire several times.
 */

const DEFAULTS = {
  onlyWhenUnfocused: true, // only ping when CLI is not in view
  sound: false,            // visual only by default
  desktop: true,
};

function envBool(name) {
  const v = process.env[name];
  if (v === undefined || v === "") return undefined;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}

// Settings, lowest to highest priority:
//   defaults → ~/.config/opencode/notify.json → env vars
//   OPENCODE_NOTIFY_SOUND, OPENCODE_NOTIFY_ONLY_UNFOCUSED, OPENCODE_NOTIFY_DESKTOP
async function loadConfig() {
  let file = {};
  try {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    const f = path.join(base, "opencode", "notify.json");
    if (fs.existsSync(f)) file = JSON.parse(fs.readFileSync(f, "utf8")) || {};
  } catch {}
  const env = {
    sound: envBool("OPENCODE_NOTIFY_SOUND"),
    onlyWhenUnfocused: envBool("OPENCODE_NOTIFY_ONLY_UNFOCUSED"),
    desktop: envBool("OPENCODE_NOTIFY_DESKTOP"),
  };
  const out = { ...DEFAULTS };
  for (const src of [file, env])
    for (const k of Object.keys(DEFAULTS))
      if (typeof src[k] === "boolean") out[k] = src[k];
  return out;
}

const CONFIG = { ...DEFAULTS };

// debug helper — use client.app.log if available, else console
async function log(client, msg, extra = {}) {
  try {
    await client.app.log({
      body: { service: "notify", level: "info", message: msg, extra },
    });
  } catch {
    console.error(`[notify] ${msg}`, extra);
  }
}

function escapeAppleScript(str) {
  return String(str).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapePs(str) {
  return String(str).replace(/'/g, "''");
}

// run a command with a hard timeout; kills it if it hangs, resolves "" on any failure
async function runWithTimeout(cmd, args, ms) {
  try {
    const { execFile } = await import("node:child_process");
    return await new Promise((resolve) => {
      execFile(cmd, args, { timeout: ms, killSignal: "SIGKILL", windowsHide: true }, (err, stdout) =>
        resolve(err ? "" : String(stdout || "")),
      );
    });
  } catch {
    return "";
  }
}

let _wslCache = null;
async function isWsl($) {
  if (_wslCache !== null) return _wslCache;
  try {
    const fs = await import("node:fs");
    const proc = fs.readFileSync("/proc/version", "utf8");
    _wslCache = proc.toLowerCase().includes("microsoft") || proc.toLowerCase().includes("wsl");
    return _wslCache;
  } catch {}
  try {
    const proc = await $`cat /proc/version`.quiet().nothrow().text();
    _wslCache = proc.toLowerCase().includes("microsoft") || proc.toLowerCase().includes("wsl");
    return _wslCache;
  } catch {
    _wslCache = false;
    return false;
  }
}

// returns true if terminal / opencode is currently focused (frontmost window)
async function isTerminalFocused($) {
  try {
    const wsl = await isWsl($);
    // WSL → check Windows foreground window title via PowerShell
    if (wsl) {
      const ps = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class F {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder t, int c);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
}
"@
$h=[F]::GetForegroundWindow()
$len=[F]::GetWindowTextLength($h)
if($len -eq 0){Write-Output "";exit}
$sb=New-Object System.Text.StringBuilder ($len+1)
[F]::GetWindowText($h,$sb,$sb.Capacity)|Out-Null
Write-Output $sb.ToString()
`.trim();
      const raw = await runWithTimeout("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], 1500);
      const title = (raw || "").trim().toLowerCase();
      if (!title) return false; // can't determine → assume not focused so we notify (fail-safe)
      // match terminal / editor apps by their window-title suffix, not loose words
      const terms = [
        "windows terminal",
        "opencode",
        "visual studio code",
        "- cursor",
        "wezterm",
        "alacritty",
        "kitty",
        "ghostty",
        "windows powershell",
        "command prompt",
      ];
      if (terms.some((t) => title.includes(t))) return true;
      // a bare WSL shell window titled like "user@host: ~/dir"
      if (/^[\w.-]+@[\w.-]+: /.test(title)) return true;
      return false;
    }

    if (process.platform === "darwin") {
      try {
        const raw = await $`osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'`.quiet().nothrow().text();
        const app = (raw || "").trim().toLowerCase();
        if (!app) return false;
        const terms = ["terminal", "iterm", "wezterm", "alacritty", "kitty", "ghostty", "code", "cursor", "warp", "hyper"];
        return terms.some((t) => app.includes(t));
      } catch {
        return false;
      }
    }

    // Linux native: try xdotool
    try {
      const raw = await $`xdotool getwindowfocus getwindowname`.quiet().nothrow().text();
      const name = (raw || "").trim().toLowerCase();
      if (name) {
        const terms = ["terminal", "opencode", "code", "alacritty", "kitty", "wezterm", "ghostty", "gnome-terminal", "konsole", "xterm"];
        if (terms.some((t) => name.includes(t))) return true;
        return false;
      }
    } catch {}
    // fallback: can't detect → assume not focused
    return false;
  } catch {
    return false;
  }
}

async function playSound($, wsl) {
  try {
    const platform = process.platform;
    if (platform === "darwin") {
      await $`afplay /System/Library/Sounds/Glass.aiff`.quiet().nothrow();
      return;
    }
    if (wsl) {
      await $`powershell.exe -Command "[System.Media.SystemSounds]::Asterisk.Play()"`.quiet().nothrow();
      return;
    }
    try {
      const fs = await import("node:fs");
      const candidates = [
        "/usr/share/sounds/freedesktop/stereo/complete.oga",
        "/usr/share/sounds/freedesktop/stereo/message.oga",
        "/usr/share/sounds/freedesktop/stereo/bell.oga",
      ];
      for (const f of candidates) {
        if (fs.existsSync(f)) {
          const out = await $`paplay ${f}`.quiet().nothrow();
          if (out.exitCode === 0) return;
        }
      }
    } catch {}
  } catch {}
  try {
    process.stdout.write("\x07");
  } catch {}
}

async function sendDesktop($, title, body, opts = {}) {
  const urgency = opts.urgency || "normal";
  const wsl = await isWsl($);
  const platform = process.platform;

  if (platform === "darwin") {
    try {
      const script = `display notification "${escapeAppleScript(body)}" with title "${escapeAppleScript(title)}" subtitle "${escapeAppleScript(opts.subtitle || "")}"`;
      await $`osascript -e ${script}`.quiet().nothrow();
      return true;
    } catch {}
  }

  if (wsl) {
    try {
      const psTitle = escapePs(title);
      const psBody = escapePs(body);
      const ps = `
try {
  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
  $template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
  $textNodes = $template.GetElementsByTagName('text')
  $textNodes.Item(0).AppendChild($template.CreateTextNode('${psTitle}')) | Out-Null
  $textNodes.Item(1).AppendChild($template.CreateTextNode('${psBody}')) | Out-Null
  $toast = [Windows.UI.Notifications.ToastNotification]::new($template)
  $notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('opencode')
  $notifier.Show($toast)
} catch { Write-Host "notify toast failed: $_" }
`.trim();
      await $`powershell.exe -Command ${ps}`.quiet().nothrow();
      return true;
    } catch {}
  }

  try {
    const out = await $`notify-send -u ${urgency} -a opencode ${title} ${body}`.quiet().nothrow();
    if (out.exitCode === 0) return true;
    const out2 = await $`notify-send -u ${urgency} ${title} ${body}`.quiet().nothrow();
    if (out2.exitCode === 0) return true;
  } catch {}

  return false;
}

async function notify($, client, title, body, opts = {}) {
  // focus-aware suppression: skip if terminal is frontmost and config says so
  const onlyUnfocused = opts.onlyWhenUnfocused ?? CONFIG.onlyWhenUnfocused;
  if (onlyUnfocused) {
    try {
      const focused = await isTerminalFocused($);
      if (focused) {
        await log(client, `suppressed (focused): ${title}: ${body}`, { title, body, suppressed: true, focused: true });
        return;
      }
    } catch (e) {
      await log(client, `focus check failed, notifying anyway: ${String(e)}`, { error: String(e) });
    }
  }

  const doDesktop = opts.desktop ?? CONFIG.desktop;
  const doSound = opts.sound ?? CONFIG.sound;

  if (doDesktop) {
    await sendDesktop($, title, body, opts);
  }
  if (doSound) {
    const wsl = await isWsl($);
    await playSound($, wsl);
  }
  // terminal bell still only when we actually notify and sound is on — respect CONFIG.sound
  if (doSound) {
    try {
      process.stdout.write("\x07");
      process.stderr.write("\x07");
    } catch {}
  }

  await log(client, `${title}: ${body}`, { title, body, ...opts });
}

export const Notify = async ({ client, $, directory }) => {
  Object.assign(CONFIG, await loadConfig());
  await log(client, "notify plugin loaded (focus-aware)", { directory, config: CONFIG });

  const lastPing = new Map();
  function shouldPing(key, ms = 2000) {
    const now = Date.now();
    const last = lastPing.get(key) || 0;
    if (now - last < ms) return false;
    lastPing.set(key, now);
    return true;
  }

  return {
    event: async ({ event }) => {
      try {
        if (event.type === "session.idle") {
          const sid = event.properties?.sessionID || "unknown";
          if (!shouldPing(`idle:${sid}`, 3000)) return;
          await notify($, client, "opencode — done ✓", `Run finished — session ${sid.slice(0, 8)}`, {
            urgency: "normal",
            subtitle: "opencode",
          });
        }

        if (event.type === "session.error") {
          const sid = event.properties?.sessionID || "unknown";
          if (!shouldPing(`error:${sid}`, 3000)) return;
          const msg = event.properties?.error?.data?.message || event.properties?.error?.name || "unknown error";
          await notify($, client, "opencode — error ✗", String(msg).slice(0, 120), {
            urgency: "critical",
          });
        }

        if (event.type === "session.status") {
          const status = event.properties?.status;
          if (status?.type === "idle") {
            const sid = event.properties?.sessionID || "unknown";
            if (!shouldPing(`status:${sid}`, 4000)) return;
            if (!shouldPing(`idle:${sid}`, 4000)) return;
            await notify($, client, "opencode — done ✓", `Run finished — session ${sid.slice(0, 8)}`, {
              urgency: "normal",
            });
          }
        }

        if (
          event.type === "permission.updated" ||
          event.type === "permission.asked" ||
          event.type === "permission.ask"
        ) {
          const perm = event.properties;
          const sid = perm?.sessionID || "unknown";
          // permission.asked and permission.updated both fire for one request: share one key
          if (!shouldPing(`perm:${sid}:${perm?.id || perm?.title || ""}`, 5000)) return;
          const title = perm?.title || perm?.type || "Permission";
          await notify($, client, "opencode — input needed ●", `${title} — approval required`, {
            urgency: "critical",
            subtitle: "needs input",
          });
        }
      } catch (e) {
        await log(client, "notify event error", { error: String(e), eventType: event.type });
      }
    },

  };
};

