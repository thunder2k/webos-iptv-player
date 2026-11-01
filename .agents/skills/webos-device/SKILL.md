---
name: webos-device
description: Install, run, and debug the app on a real LG webOS TV — packaging, cold restart, console logs, and live page evaluation over CDP. Use when deploying to a TV or investigating behavior that only reproduces on the device.
---

# webOS device

## Build and install

```bash
./build.sh                     # package the IPK (needs ares-package from @webos-tools/cli)
./build.sh --install [device]  # build + ares-install + cold-restart on a TV
```
**Always create a new version of the app bumping version numberbefore installing it on a TV.** webOS does not update the in-memory copy of the app on an in-place upgrade, so a relaunch resumes the stale instance. The `--install` option closes the app, then cold-starts it to load the new bundle. If you install another way, close and relaunch it.

**Install needs a cold restart.** webOS keeps the old instance suspended
through an in-place upgrade, and a plain relaunch resumes the stale
in-memory copy. `build.sh --install` closes the app, then cold-starts it to
load the new bundle. If you install another way, close and relaunch it.

## Debug

`scripts/tv.sh` wraps the device access that the `tv` CLI profile blocks:

| Command | Use |
| --- | --- |
| `tv.sh logs` | Tail the app's DevTools console. |
| `tv.sh eval '<js>'` | Probe live DOM or app state. |
| `tv.sh perf` | Performance counters and profiles. |
| `tv.sh diag` | Diagnostics report. |
| `tv.sh capt` | Screenshot or recording. |
| `tv.sh input` | Remote keys, pointer, wheel, and wake. |
| `tv.sh run '<cmd>'` | Run a shell command on the TV over ssh. |
| `tv.sh push <local> <remote>` / `pull <remote> <local>` | Copy files to or from the TV (`ares-push` is disabled in the `tv` profile). |
| `tv.sh shell` | Interactive shell (`ares-shell` is disabled in the `tv` profile). |
| `tv.sh reboot` | Reboot the TV through Luna. |

Pick a non-default device with `TV_DEVICE=<name>`; override the expect
timeout with `TV_TIMEOUT=<seconds>` (default 120). `logs`, `eval`, `perf`,
`diag`, `capt`, and `input` print their full options with `-h` or
`--help`.

Notes:

- `ares-inspect` exposes a page-level CDP socket only. Playwright
  `connectOverCDP` fails; connect to the page WebSocket directly.
- App `console.*` output appears only in the DevTools that `ares-inspect`
  opens (or through `tv.sh logs`). `ares-monitor-log` is not in the current
  CLI.
- Logs come from `createLogger('Tag')`, so filter on the `[Tag]` prefix.
- `tv.sh input` writes Linux input events into the TV's own remote devices,
  so webOS shows and hides the cursor, scrolls natively, and sends keydown
  1536/1537 (cursor shown/hidden) exactly as with a real remote. Synthetic
  CDP or DOM events skip all of that.
- Never inject `KEY_EXIT` (evdev 174): webOS closes the app.
- `tv.sh input key power` turns the TV off and `tv.sh input wake` turns
  it back on. Use them only when the user asks.

## When the device is required

The desktop preview and the Chromium 53 simulation cannot reproduce
engine-level layout, V8 behavior, native media pipelines (audio and subtitle
track switching, DASH), Luna services, or Activity Manager callbacks. Verify
those on a TV before calling the change done.

## Compatibility

Always test on the lowest supported webOS version. The LG TV emulator is not a reliable substitute for a real device. Fix the code, deploy on the telly which is on the same lan, get the logs and make sure everything works fine, otherwise keep iterating. The telly is an OLED65B7V-Z with webOS TV Version 3.93-6270915 (dreadlocks2-dudhwa)