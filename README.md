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
| Hold OK or Yellow | Edit the app or input | Done |
| Green | Show hidden apps, or leave them out again | Add to or remove from Favorites (inputs too) |
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
| `theme` | The starting theme: `ambient`, `aurora`, `midnight` or `photo` (Wallpaper). Once you pick one with the blue button, the TV's choice wins. |
| `tiles` | Your own tile looks, keyed by app name or ID, or input ID: `title` (a new name), `bgColor`, `icon` (a picture; plain margins are trimmed) and `removeBackground` (makes the icon's plain border see-through, for icons that come on a solid square). E.g. `{"Netflix": {"bgColor": "#000000"}, "HDMI_2": {"icon": "media/tiles/spectrum-tv.png", "bgColor": "#ffffff"}}`. |
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

## On a rooted TV

With the Homebrew Channel's SSH server on, the tools install over root SSH instead of Developer Mode. Nothing expires, so the Developer Mode timer below isn't needed. **Uninstall the Developer Mode app before restarting a rooted TV**: if it's still installed at startup, the TV can delete every sideloaded app, the Homebrew Channel included.

```sh
ssh-keygen -t rsa -b 4096 -N "" -f ~/.ssh/tv_root   # once
npm run root-ssh                                   # installs the key, switches the tools to root SSH
npm run deploy
npm run install-ipk -- some-app.ipk                # any other webOS package
```

`root-ssh` logs in with the Homebrew Channel's default password the first time and installs the key. After the next restart the TV only accepts the key. It also sets `tv.root` in `config.json`, which makes `deploy`, `install-ipk` and the hourly updater use `scp` and the TV's installer service (`luna-send`) over SSH. LG's `ares-install` doesn't work here because the Homebrew Channel's SSH server refuses the second command it sends.

### TV-side hooks

`tv/init.d/` holds startup hooks for a rooted TV; `npm run tv-setup` copies them to `/var/lib/webosbrew/init.d/` and starts them, and installs `tv/bin/` and Input Hook's keybinds. The Homebrew Channel runs the hooks at every boot.

- `20-close-devtools-port`: closes the debug port (below).
- `30-launcher-on-wake`: opens the launcher when the TV is turned on with the remote (the TV reports why it turned on: `getPowerOnReason` says `remoteKey`), and for 20 seconds takes the screen back if a device woken with the TV grabs it over HDMI-CEC. When something else turned the TV on, such as a console over HDMI-CEC, it stays where that put it. Its log is `/run/minimal-launcher/launcher-on-wake.log`; `30-launcher-on-wake states` prints power states as they change.

### Commercial mute

`tv/bin/commercial-mute` mutes the TV for 2½ minutes and then unmutes it; run again while muted, it unmutes at once. `tv/lginputhook/keybinds.json` puts it on the remote's Mute button (code 113), next to Home → launcher (773) and 1 → LG's home bar (2). `npm run tv-setup` installs both. To change the length, edit the `150` in the keybinds file.

### Layout backup

On a rooted TV the launcher copies its order, hidden apps, Favorites and theme to `/home/root/.config/minimal-launcher/layout.json` (through the Homebrew Channel's root service) whenever they change. A fresh install restores them from there. `sync` also keeps a copy in `backup/layout.json` and packages it, for when the TV itself was reset.

### Opening Plex titles

With `plex.appId` set to PlxNative, a Continue Watching card resumes that title, and a Recently Added card opens its page, using [PlxNative's launch links](https://github.com/GLinnik21/plx-native). On webOS before 7.4 a link only works on a cold start, so the launcher closes PlxNative first.

### Closing the debug port

webOS opens the web app manager's remote debugging port (9998) on every network interface. On a rooted TV it lets anyone on the network script the Homebrew Channel, which has root. The kernel has no firewall, so a startup hook in `/var/lib/webosbrew/init.d/20-close-devtools-port` bind-mounts a copy of `/etc/systemd/system/scripts/webapp-mgr.sh` without `--remote-debugging-port` and restarts the web app manager. (`--remote-debugging-address=127.0.0.1` was tried first; the web app manager ignores it.) To reopen the port for debugging until the next restart:

```sh
umount /etc/systemd/system/scripts/webapp-mgr.sh && systemctl restart webapp-mgr
```

### Home button

[LG Input Hook](https://github.com/Simon34545/lginputhook), a root-only app from the Homebrew Channel, can make the remote's Home button open the launcher. Install it, open it once (that starts it, and it then starts itself at boot), and put this in `/home/root/.config/lginputhook/keybinds.json` on the TV:

```json
{
  "773": {"action": "launch", "id": "com.minimal.launcher"},
  "2": {"action": "launch", "id": "com.webos.app.home"}
}
```

773 is Home on LG's infrared remotes (checked on an AKB75675313); it opens the launcher. 2 is the **1** button; it opens LG's own home bar (`com.webos.app.home`) as a fallback. Input Hook reloads the file when it changes. To find another button's code, open Input Hook and watch its log while pressing the button. Don't press "Save changes" in Input Hook's own screen unless it shows your keybinds, because it overwrites the file with what it shows.

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
