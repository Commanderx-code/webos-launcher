# webOS Launcher

A minimal home screen for LG webOS TVs, made for a stock TV in Developer Mode (webOS 5 and later). It has:

- a grid of your apps, which you can rearrange and hide
- your HDMI inputs, under the names you gave them on the TV
- a clock
- four themes: **Ambient** (the focused app's color glows behind the grid), **Aurora** (slowly drifting colors), **Midnight** (plain dark) and **Wallpaper** (your own picture)
- Continue Watching from your Plex server. Pressing OK on the Plex tile opens a row of what you're partway through.

There's no build step. The app is plain HTML, CSS and JavaScript in `app/`, written for the Chromium 68 engine that webOS 5 runs.

## Controls

| Button | On an app | In edit mode | In Continue Watching |
| --- | --- | --- | --- |
| Arrows | Move around | Move the app | Browse |
| OK | Open it (Plex: open Continue Watching) | Done | Open Plex |
| Hold OK or Yellow | Rearrange or hide | | |
| Red | | Hide or unhide | |
| Green | Show hidden apps, or leave them out again | | |
| Blue | Next theme | | Next theme |
| Back | Close what's open | Done | Close |

The order, hidden apps and theme are saved on the TV. The Magic Remote pointer also works: hover to focus, click to open.

## Setup

You need Node.js 20 or later on your computer, with the computer and TV on the same network.

### 1. Put the TV in Developer Mode

1. Create a free account at [webostv.developer.lge.com](https://webostv.developer.lge.com).
2. On the TV, install **Developer Mode** from the LG Content Store and sign in with that account.
3. Turn **Dev Mode Status** on and let the TV restart. Then open Developer Mode again and turn **Key Server** on.

### 2. Connect your computer

```sh
npm install
cp config.example.json config.json   # set tv.host to the TV's IP address
npx ares-setup-device -a tv -i "host=192.168.1.50" -i "port=9922" -i "username=prisoner"
npx ares-novacom -d tv --getkey      # enter the passphrase shown in the Developer Mode app
```

The sync step talks to the TV over LG's network API, the one phone remote apps use. Make sure **LG Connect Apps** is on. On webOS 5 it's under Settings → All Settings → Connection → Mobile Connection Management.

### 3. Sign in to Plex (optional)

```sh
npm run plex-login
```

This opens a Plex sign-in page in your browser. Once you approve it, the script picks your server, finds an address the TV can reach on your network, and saves the address and token in `config.json`. If you'd rather do it by hand, fill in `plex.server` and `plex.token` yourself.

The script prefers your server's encrypted `plex.direct` address. If the Plex row on the TV says it can't reach the server, the TV's older browser may not accept that certificate. In that case set `plex.server` to the plain address (e.g. `http://192.168.1.10:32400`) and rerun `npm run sync`. The token then crosses your home network unencrypted.

### 4. Read your apps and install

```sh
npm run sync     # the TV asks once to allow the connection; accept it with the remote
npm run deploy   # packages the app, installs it and opens it
```

`sync` writes your apps, their icons, your inputs and the Plex settings into `app/data/`. Rerun `sync` and `deploy` after you install or remove apps on the TV.

To leave apps out of the launcher for good, list their names in `"exclude"` in `config.json` (e.g. `["Music", "Sports Alert"]`), then run `sync` and `deploy`. To hide one from the TV instead, hold OK on it and press red.

To add the Wallpaper theme, set `"wallpaper"` in `config.json` to a picture on your computer (e.g. `"~/Pictures/tv.jpg"`). A 1920×1080 JPEG under 1 MB works best. Then run `sync` and `deploy`.

### 5. Make it quick to reach

A stock TV won't let an app replace the Home button. Two things get close:

- **Pin it first.** Press Home, select the Launcher in the app bar, hold OK and move it to the front.
- **Quick Access** (on most LG remotes). With the launcher open, press and hold a number button on the remote (e.g. 1) to bind it. After that, holding 1 opens the launcher from anywhere.

## Keeping Developer Mode alive

Developer Mode runs out after 50 hours, and **when it does the TV deletes the launcher**. To reset the timer, press Extend in the Developer Mode app or run:

```sh
npm run extend-devmode
```

The first run has to reach the TV. It saves the session token in `config.json`, and later runs use the saved token when the TV is in standby.

To run it every day, add a systemd user timer:

```ini
# ~/.config/systemd/user/webos-devmode-extend.service
[Unit]
Description=Extend LG webOS Developer Mode session
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=%h/github/projects/webos-launcher
ExecStart=/usr/bin/node tools/extend-devmode.mjs

# ~/.config/systemd/user/webos-devmode-extend.timer
[Unit]
Description=Extend LG webOS Developer Mode session daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

```sh
systemctl --user enable --now webos-devmode-extend.timer
journalctl --user -u webos-devmode-extend   # what the last runs said
```

User timers only run while you're logged in, and `Persistent=true` catches up on a missed run at the next login. Logging in at least every other day is enough. Otherwise, run `loginctl enable-linger` so the timer runs without a login.

## What it can't do

- **No Continue Watching for Netflix, YouTube, Disney+, Prime Video and similar apps.** webOS doesn't let one app read another's data, and those services have no public API for it. Plex works because your server has one.
- **Plex cards open the Plex app, not the episode itself.** There's no documented way to tell Plex for LG which item to play from another app.
- **Apps don't update by themselves.** A stock TV refuses to give sideloaded apps the list of installed apps, so the list comes from `npm run sync`. On a rooted TV, the launcher tries to read the live list instead.

## Layout

```
app/          the TV app (appinfo.json, index.html, style.css, main.js, luna.js, plex.js)
app/data/     written by `npm run sync`; not in git (it holds your Plex token)
tools/        sync, plex-login, deploy and extend-devmode scripts
config.json   your TV address and Plex settings; not in git
```

To preview in a desktop browser, open `app/index.html` with the window at 1920×1080. Use Enter, the arrow keys, Esc for Back, and R, G, Y and B for the color buttons.
