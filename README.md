# webOS Launcher

A minimal home screen for LG webOS TVs, made for a stock TV in Developer Mode (webOS 5 and later). From the top:

- **Weather and clock** in the corner
- **Favorites**: a row of big tiles for the apps you use most
- **Continue Watching** and **Recently Added** from your Plex server
- **All Apps**: everything else, which you can rearrange and hide
- **Inputs**: only the ones with something plugged in, named after the device when it says what it is
- **Themes**: **Ambient** (the focused app's color glows behind the grid), **Aurora** (slowly drifting colors), **Midnight** (plain dark) and **Wallpaper** (your own picture or looping video)
- **Screensaver**: after a few idle minutes, a big clock and the weather over your own pictures and videos, or Plex artwork

There's no build step. The app is plain HTML, CSS and JavaScript in `app/`, written for the Chromium 68 engine that webOS 5 runs.

## Controls

| Button | Browsing | Editing an app |
| --- | --- | --- |
| Arrows | Move around | Move the app (Favorites: left and right) |
| OK | Open the app, switch input, or open Plex from a Plex card | Done |
| Hold OK or Yellow | Edit the app | Done |
| Green | Show hidden apps, or leave them out again | Add to or remove from Favorites |
| Red | | Hide or unhide |
| Blue | Next theme | |
| Back | Leave out hidden apps again | Done |

Any button wakes the screensaver without doing anything else. The order, Favorites, hidden apps and theme are saved on the TV. The Magic Remote pointer also works: hover to focus, click to open.

## Setup

You need Node.js 20 or later on your computer, with the computer and TV on the same network.

### 1. Put the TV in Developer Mode

1. Create a free account at [webostv.developer.lge.com](https://webostv.developer.lge.com).
2. On the TV, install **Developer Mode** from the LG Content Store and sign in with that account.
3. Turn **Dev Mode Status** on and let the TV restart. Then open Developer Mode again and turn **Key Server** on. Keep the app open on screen for the next step.

### 2. Connect your computer

```sh
npm install
cp config.example.json config.json   # set tv.host to the TV's IP address
npx ares-setup-device -a tv -i "host=192.168.1.50" -i "port=9922" -i "username=prisoner"
npx ares-novacom -d tv --getkey      # needs Key Server on
npx ares-setup-device -m tv -i "privatekey=tv_webos" -i "passphrase=XXXXXX"   # the passphrase shown in Developer Mode
```

The sync step talks to the TV over LG's network API, the one phone remote apps use. Make sure **LG Connect Apps** is on. On webOS 5 it's under Settings → All Settings → Connection → Mobile Connection Management.

### 3. Sign in to Plex (optional)

```sh
npm run plex-login
```

This opens a Plex sign-in page in your browser. Once you approve it, the script picks your server, finds an address it can reach, and saves the address and token in `config.json`. If you'd rather do it by hand, fill in `plex.server` and `plex.token` yourself.

The script prefers your server's encrypted `plex.direct` address. If the Plex rows on the TV say they can't reach the server, the TV's older browser may not accept that certificate. In that case set `plex.server` to the plain address (e.g. `http://192.168.1.10:32400`) and rerun `npm run sync`. The token then crosses your network unencrypted.

### 4. Read your apps and install

```sh
npm run sync     # the TV asks once to allow the connection; accept it with the remote
npm run deploy   # packages the app, installs it and opens it
```

`sync` writes your apps, icons, inputs and settings into `app/data/`. After that the hourly updater (below) keeps it current.

### 5. Make it quick to reach

A stock TV won't let an app replace the Home button. Two things get close:

- **Pin it first.** Press Home, select the Launcher in the app bar, hold OK and move it to the front.
- **Quick Access** (on most LG remotes). With the launcher open, press and hold a number button on the remote (e.g. 1) to bind it. After that, holding 1 opens the launcher from anywhere.

## Settings in config.json

| Setting | What it does |
| --- | --- |
| `favorites` | The starting Favorites row, by app name. Once you change Favorites on the TV, the TV's choice wins. |
| `exclude` | Apps to leave out of the launcher entirely, by name (e.g. `["Music", "Sports Alert"]`). |
| `inputNames` | Names for inputs, by ID (e.g. `{"HDMI_1": "Xbox"}`). Otherwise the device's own name or the TV's label is used. |
| `showAllInputs` | `true` to show inputs with nothing plugged in. |
| `weather.zip` | The ZIP code for the weather. Leave `weather` out to hide it. `weather.units` is `fahrenheit` or `celsius`. |
| `screensaverMinutes` | Idle minutes before the screensaver starts (default 5); `0` turns it off. |
| `screensaverFolder` | A folder of your own pictures and videos for the screensaver, shown in random order, e.g. `"~/Pictures/Launcher screen savers"`. Pictures stay up 12 seconds; videos play through. Leave it empty to show Plex artwork instead. |
| `plex.appId` | The app the Plex cards open, by app ID. Defaults to the official Plex app; e.g. `"com.beb.plxnative"` for PlxNative. |
| `wallpaper` | A picture or a short looping video (`.mp4` or `.webm`) for the Wallpaper theme, e.g. `"~/Videos/loop.mp4"`. Videos play silently. Keep them short and 1080p; the whole file goes onto the TV. |

Pictures and videos for the wallpaper and screensaver are converted to 1080p (JPEG, or silent H.264 video) when they're synced. Converted copies are kept in `media/cache`, so only new or changed files are converted again.

The updater picks up changes here, and files added to the screensaver folder, within the hour. To see them right away, run `npm run sync` and `npm run deploy`.

## Automatic updates

`tools/auto-update.mjs` runs every hour from a systemd user timer. If the TV is on, it syncs. If anything changed since the last install (apps installed or removed, settings, or the launcher's own code), it reinstalls the launcher without opening it. When the launcher is on screen it waits for the next run, because reinstalling closes it.

```ini
# ~/.config/systemd/user/webos-launcher-update.service
[Unit]
Description=Update the TV launcher when the TV's apps or the settings change
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/github/projects/webos-launcher
ExecStart=/usr/bin/node tools/auto-update.mjs
TimeoutStartSec=10min

# ~/.config/systemd/user/webos-launcher-update.timer
[Unit]
Description=Check the TV for launcher updates every hour

[Timer]
OnCalendar=hourly
RandomizedDelaySec=5min

[Install]
WantedBy=timers.target
```

```sh
systemctl --user enable --now webos-launcher-update.timer
journalctl --user -u webos-launcher-update   # what the last runs did
```

## Keeping Developer Mode alive

When the Developer Mode session runs out, **the TV deletes the launcher**. Current versions of the Developer Mode app give 1000 hours; older ones gave 50. To reset it, press Extend in the Developer Mode app or run:

```sh
npm run extend-devmode
```

The first run has to reach the TV. It saves the session token in `config.json`, and later runs use the saved token when the TV is in standby. To run it daily, add a timer like the one above, with `OnCalendar=daily`, `Persistent=true` and `ExecStart=/usr/bin/node tools/extend-devmode.mjs`.

User timers only run while you're logged in. `Persistent=true` catches up on a missed run at the next login. Otherwise, run `loginctl enable-linger` so timers run without a login.

## What it can't do

- **No Continue Watching for Netflix, YouTube, Disney+, Prime Video and similar apps.** webOS doesn't let one app read another's data, and those services have no public API for it. Plex works because your server has one.
- **Plex cards open the Plex app, not the title itself.** There's no documented way to tell Plex for LG which item to play from another app.
- **The Home button can't be remapped** on a stock TV. See Quick Access above.
- **The screensaver only runs on the launcher.** The TV's own screensaver and power settings still apply everywhere else.

## Layout

```
app/          the TV app: index.html, style.css, main.js, luna.js, plex.js, weather.js
app/data/     written by `npm run sync`; not in git (it holds your Plex token)
tools/        sync, auto-update, deploy, plex-login and extend-devmode
config.json   your TV address and settings; not in git
dist/         the built package and a fingerprint of what's installed
```

To preview in a desktop browser, open `app/index.html` with the window at 1920×1080. Use Enter, the arrow keys, Esc for Back, and R, G, Y and B for the color buttons.
