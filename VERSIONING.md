# IPK Versioning (for easy rollback)

Every IPK build should carry a **new version number** so previous builds can be
reverted on the TV if a release breaks playlist loading or playback.

## Version source of truth

`package.json` `version` is the single source of truth. It is synced into
`appinfo.json` and the `__APP_VERSION__` build constant by
`scripts/sync-version.mjs` (runs automatically on `npm version`). Never hand-edit
`appinfo.json` or the version in `esbuild.config.mjs`.

## Bump version + build + deploy

```bash
# 1. Bump the version (patch = 1.16.0 -> 1.16.1; use minor/major for bigger changes)
npm version patch -m "v%s"

# 2. Build, package, install, and launch on the TV
./build.sh --install <device-name>
```

`npm version` bumps `package.json`, runs the sync script, stages `appinfo.json`,
and commits with the given message. The resulting IPK file name includes the
version, e.g. `com.lennylxx.iptv_1.16.1_armv7l.ipk`, so you can tell which build
is installed and keep older `.ipk` files around for sideloading/rollback.

## Reverting to a previous build

Keep the `.ipk` files from prior builds (they are left in the project root by
`build.sh`). To roll back on the TV:

```bash
ares-install --device <device-name> com.lennylxx.iptv_<old-version>_armv7l.ipk
ares-launch --device <device-name> --close com.lennylxx.iptv
ares-launch --device <device-name> com.lennylxx.iptv
```

A plain relaunch after an in-place upgrade resumes the stale in-memory copy, so
always `--close` then relaunch to cold-start the new bundle (this is handled
automatically by `build.sh --install`).

## Device setup

The TV must be registered as an ares device first:

```bash
ares-setup-device
```

Add the TV at `192.168.1.123` (port 9922 for ares-novacom). The device name is
whatever you choose during setup and is passed as `<device-name>` above.

## When to bump

- **Every** `build.sh --install` that goes to the TV should use a fresh version
  so you can roll back if the new bundle breaks the playlist.
- Bump `patch` for fixes, `minor` for features, `major` for breaking changes.
- Do **not** bump just to re-build the same code for local testing — only when
  a build is intended for the TV.
