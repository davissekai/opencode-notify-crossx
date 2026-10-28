# opencode-notify-crossx

Cross-platform desktop notifications for [opencode](https://opencode.ai) — get pinged when your run finishes or when input is needed.

Focus-aware: only pings when opencode is not the frontmost window, so you are not spammed while watching.

| Platform | Visual | Sound (off by default) | Focus check |
|----------|--------|------------------------|-------------|
| WSL (Windows) | PowerShell `Windows.UI.Notifications` toast | `SystemSounds` | `GetForegroundWindow` |
| macOS | `osascript` display notification | `afplay` | `System Events` frontmost |
| Linux | `notify-send` via libnotify | `paplay` | `xdotool` |

No sound by default — visual toast only. See [Settings](#settings) to turn it on.

## Install

```bash
npm i -g opencode-notify-crossx
# or for local install
npm i opencode-notify-crossx
```

Add to your opencode config:

`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-notify-crossx"]
}
```

Or project-level `.opencode/opencode.json`:

```json
{
  "plugin": ["opencode-notify-crossx"]
}
```

Restart opencode.

## What triggers a ping

- `session.idle` → Run finished
- `session.error` → Run failed
- `permission.asked` / `permission.updated` → Input needed (one ping per request)

Debounced per session/permission to avoid spam.

## Focus-aware

Only notifies when your terminal or editor is not the frontmost window, so you are not pinged while watching. On WSL it checks the Windows foreground window title; on macOS the frontmost app; on Linux `xdotool` (X11 only, so on Wayland it always notifies).

## Settings

No code edits needed. Use environment variables:

```bash
export OPENCODE_NOTIFY_SOUND=1            # play a sound too (default: off)
export OPENCODE_NOTIFY_ONLY_UNFOCUSED=0   # ping even when focused (default: on)
export OPENCODE_NOTIFY_DESKTOP=0          # no desktop toast (default: on)
```

Or a file at `~/.config/opencode/notify.json`:

```json
{ "sound": true, "onlyWhenUnfocused": false }
```

Env vars override the file.

## Local development (single-file plugin)

The same code also works as a single-file local plugin at `~/.config/opencode/plugins/notify.js` — no npm needed. See `index.js` source.

## How it works

- `isWsl()` checks `/proc/version` for `microsoft`/`wsl`
- `isTerminalFocused()` checks foreground window title via PowerShell on WSL/Windows, AppleScript on macOS, `xdotool` on Linux
- `sendDesktop()` tries `osascript` → PowerShell toast → `notify-send` in order
- `notify()` respects `onlyWhenUnfocused` and `sound`
- One plugin export only, and one debounced ping per permission request, so you never get duplicates

## License

MIT

## Author

Davis Dey — first open source contribution, built live with opencode
