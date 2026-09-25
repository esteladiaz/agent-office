# The Agent Keep — macOS launcher

A double-clickable app that opens http://127.0.0.1:7331/ in a Chrome app-mode window (no tabs, no address bar). If nothing is listening on port 7331, it first runs the server from this repo.

If `${APP_DIR}/.env.local` exists, the launcher starts `node --env-file=.env.local server.mjs` so Cursor Cloud agents load; otherwise it runs `node server.mjs`.

The finished app lives at `/Applications/The Agent Keep.app`. Finder’s sidebar “Applications” is `/Applications`, not `~/Applications`.

## Prerequisites

- Google Chrome at `/Applications/Google Chrome.app`
- This repo checked out at `~/code/agent-office` (the launcher hardcodes `/Users/esdiaz/code/agent-office`)
- Node on the machine. Finder does not inherit a terminal’s PATH, so node from nvm, Homebrew, or `/usr/local` will not be visible unless the launcher finds it itself. The script below checks `~/.nvm/versions/node` (honoring `~/.nvm/alias/default`, with or without a leading `v`), then `/opt/homebrew/bin` and `/usr/local/bin`.

## Bundle layout

```
/Applications/The Agent Keep.app/
  Contents/
    Info.plist
    MacOS/launcher          # executable shell script
    Resources/AppIcon.icns  # optional
```

Create the directories:

```bash
APP="/Applications/The Agent Keep.app"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
```

## Contents/Info.plist

`LSUIElement` is true so the launcher itself does not sit in the Dock. The visible window is Chrome’s.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleName</key>
	<string>The Agent Keep</string>
	<key>CFBundleDisplayName</key>
	<string>The Agent Keep</string>
	<key>CFBundleIdentifier</key>
	<string>local.zreed.the-agent-keep</string>
	<key>CFBundleExecutable</key>
	<string>launcher</string>
	<key>CFBundleIconFile</key>
	<string>AppIcon</string>
	<key>CFBundlePackageType</key>
	<string>APPL</string>
	<key>CFBundleShortVersionString</key>
	<string>1.0</string>
	<key>CFBundleVersion</key>
	<string>1</string>
	<key>LSUIElement</key>
	<true/>
</dict>
</plist>
```

## Contents/MacOS/launcher

Write this file, then `chmod +x` it.

```bash
#!/bin/bash
# Starts The Agent Keep server if needed, then opens a Chrome app-mode window.

set -u

URL="http://127.0.0.1:7331/"
PORT=7331
APP_DIR="/Users/esdiaz/code/agent-office"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
LOG_DIR="${HOME}/Library/Logs"
LOG="${LOG_DIR}/TheAgentKeep.log"
PIDFILE="${HOME}/Library/Application Support/TheAgentKeep/server.pid"

# Finder launches do not inherit the shell's nvm PATH, so resolve node here.
# The default alias may be stored with or without the leading "v".
nvm_bin() {
  local root="${HOME}/.nvm/versions/node" alias_file="${HOME}/.nvm/alias/default" want dir
  [[ -d "${root}" ]] || return 1
  if [[ -r "${alias_file}" ]]; then
    want="$(tr -d '[:space:]' <"${alias_file}")"
    for dir in "${root}/${want}" "${root}/v${want#v}"; do
      [[ -x "${dir}/bin/node" ]] && { echo "${dir}/bin"; return 0; }
    done
  fi
  dir="$(ls -1 "${root}" 2>/dev/null | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -1)"
  [[ -n "${dir}" && -x "${root}/${dir}/bin/node" ]] && { echo "${root}/${dir}/bin"; return 0; }
  return 1
}

export PATH="$(nvm_bin || true):/opt/homebrew/bin:/usr/local/bin:${PATH}"

mkdir -p "${LOG_DIR}" "$(dirname "${PIDFILE}")"

port_in_use() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN >/dev/null 2>&1
}

wait_for_port() {
  local i
  for i in $(seq 1 50); do
    if port_in_use; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

if ! port_in_use; then
  if ! command -v node >/dev/null 2>&1; then
    osascript -e 'display notification "Could not find node in PATH." with title "The Agent Keep"' >/dev/null 2>&1
    echo "$(date '+%Y-%m-%d %H:%M:%S') node not found" >>"${LOG}"
    exit 1
  fi

  if [[ ! -f "${APP_DIR}/server.mjs" ]]; then
    osascript -e 'display notification "server.mjs was not found in code/agent-office." with title "The Agent Keep"' >/dev/null 2>&1
    echo "$(date '+%Y-%m-%d %H:%M:%S') missing ${APP_DIR}/server.mjs" >>"${LOG}"
    exit 1
  fi

  cd "${APP_DIR}" || exit 1
  if [[ -f "${APP_DIR}/.env.local" ]]; then
    echo "$(date '+%Y-%m-%d %H:%M:%S') starting node --env-file=.env.local server.mjs" >>"${LOG}"
    nohup node --env-file=.env.local server.mjs >>"${LOG}" 2>&1 &
  else
    echo "$(date '+%Y-%m-%d %H:%M:%S') starting node server.mjs" >>"${LOG}"
    nohup node server.mjs >>"${LOG}" 2>&1 &
  fi
  echo $! >"${PIDFILE}"

  if ! wait_for_port; then
    osascript -e 'display notification "Server did not start on port 7331." with title "The Agent Keep"' >/dev/null 2>&1
    echo "$(date '+%Y-%m-%d %H:%M:%S') timed out waiting for ${PORT}" >>"${LOG}"
    exit 1
  fi
fi

"${CHROME}" --app="${URL}" >/dev/null 2>&1 &
disown
exit 0
```

```bash
chmod +x "$APP/Contents/MacOS/launcher"
```

## What a click does

1. If something is already listening on TCP 7331, skip straight to Chrome.
2. Otherwise resolve node, `cd ~/code/agent-office`, and `nohup` the server (`node --env-file=.env.local server.mjs` when `.env.local` exists, else `node server.mjs`).
3. Wait up to 5 seconds for the port. On failure, post a macOS notification and append a line to the log.
4. Open Chrome with `--app=http://127.0.0.1:7331/`.

Behavior worth knowing:

- Uses the normal Chrome profile, so existing logins and extensions apply.
- Each click opens a new window. It does not focus an existing one.
- The server is left running after the window closes. A later click reuses it.
- Logs: `~/Library/Logs/TheAgentKeep.log`. Pid file: `~/Library/Application Support/TheAgentKeep/server.pid` (written only when this launcher starts the server; a server you started yourself in a terminal is detected by the port check and has no pid file).

## Icon (optional)

`CFBundleIconFile` is `AppIcon`, so macOS looks for `Contents/Resources/AppIcon.icns`. Without it, the app still launches and shows a generic icon.

From a square PNG (real PNG bytes, not a JPEG renamed `.png`):

```bash
SRC=/path/to/icon.png
rm -rf /tmp/AppIcon.iconset
mkdir /tmp/AppIcon.iconset
sips -s format png "$SRC" --out /tmp/agent-keep-src.png
for s in 16 32 128 256 512; do
  sips -s format png -z $s $s /tmp/agent-keep-src.png --out /tmp/AppIcon.iconset/icon_${s}x${s}.png
  d=$((s * 2))
  sips -s format png -z $d $d /tmp/agent-keep-src.png --out /tmp/AppIcon.iconset/icon_${s}x${s}@2x.png
done
iconutil -c icns /tmp/AppIcon.iconset -o "$APP/Contents/Resources/AppIcon.icns"
```

`sips` will say “Output file suffix should be jpg” and `iconutil` will fail if the source is a JPEG with a `.png` name. The `-s format png` conversion above avoids that.

## Register and pin

```bash
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
```

Then drag `/Applications/The Agent Keep.app` onto the Dock, or launch it from Spotlight as “The Agent Keep”.

If the Dock icon was created while the bundle lived somewhere else, that Dock item still points at the old path. Remove it and drag the `/Applications` copy again. A stale generic icon usually clears after logging out, or after `lsregister -f`.

## Check that it works

Cold start (stop any existing server first, or just confirm the port is free):

```bash
lsof -nP -iTCP:7331 -sTCP:LISTEN   # expect nothing
open "/Applications/The Agent Keep.app"
sleep 3
lsof -nP -iTCP:7331 -sTCP:LISTEN   # expect node
pgrep -fl 'app=http://127.0.0.1:7331'
tail ~/Library/Logs/TheAgentKeep.log
```

A second click while the server is up should open another Chrome window and not append another starting line.

To prove node resolution the way Finder sees it (empty environment, no nvm on PATH), extract `nvm_bin` and run it under `env -i`. It should print a directory containing an executable `node`.

## Retargeting

Edit `URL`, `PORT`, and `APP_DIR` at the top of `Contents/MacOS/launcher`. The port check and the Chrome URL must stay in sync. `PORT` inside `server.mjs` defaults to 7331; override it only if both sides change together.
