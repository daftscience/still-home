# Still Home

A minimalist homescreen and local-network phone companion for rooted LG webOS TVs. Includes a clock, date, configurable weather, a chosen app list, and photo or silent MP4 wallpapers.

## Install from Homebrew Channel

Add this custom repository URL in Homebrew Channel → Settings → Repositories:

```text
https://raw.githubusercontent.com/daftscience/still-home/main/repository/repo.json
```

The repository, manifest, icon and release package are public and require no GitHub account or token. This is an independent custom feed, not a listing in the official webOS Homebrew catalogue. **Install, launch Still Home, and choose “Finish setup” on the TV. No computer or SSH is needed.**

## Features

- TV remote arrows and Magic Remote pointer; configurable clock/date/weather sizes and text shadows.
- Select and reorder installed apps.
- Retained wallpaper library with rename, confirmed deletion and per-photo focal points.
- Optional Ken Burns motion with a 25–300% speed slider. MP4 wallpapers keep their own motion.
- QR phone pairing, remembered devices, mobile uploads and phone-side image resizing.
- Collapsible mobile settings and a dismissible Home Screen-help banner.
- Optional launch after startup/standby wake, with bounded recovery if LG Home takes over.
- Separate Magic Mapper Home-button setup; LG Home is not removed or patched.
- Confirmed reset clears Still Home settings, uploaded wallpapers and remembered phones.

The included wallpaper is **Cape Cod Sunset**, shared by the project owner for this release. Its saved focal point is bundled and used on fresh installs and when upgrading an older default background. Later focal edits (including original framing) remain saved. Image metadata is stripped without changing decoded pixels. No other personal photos, TV backups, pairing credentials, local device state, screenshots or live-TV test records are included.

## Requirements and installation

Experimental software for a rooted LG webOS TV with Homebrew Channel. The app has been exercised on an LG B2 running webOS25 (internal webOS 10); other models and firmware are unverified. Startup was tested through the real boot-hook launch path and simulated power transitions; full physical off/on timing still needs verification.

1. Install the release IPK using Homebrew Channel or the webOS developer tools.
2. Launch Still Home and choose **Finish setup** when prompted. This grants **only** `com.tomperry.stillhome.service` root access through the installed Homebrew Channel, adds Still Home's boot-script symlink, and restarts its service. It does not reset data, change remote bindings or enable launch at start. An update or reinstall can reset service permissions; the app detects this and offers setup again. Never grant setup access to an untrusted package.
3. Open Still Home from the TV's app list. In Settings → Pairing, display the QR code and scan it with your phone on the same trusted Wi-Fi.
4. Optional: enable General → Launch at start. For the remote's Home button, configure Home → Launch app → Still Home in Magic Mapper. Other remote bindings remain managed there.

If setup fails, confirm Homebrew Channel is installed and its **Root status** is **ok**, then select **Retry setup**. Non-rooted TVs are not supported. Setup refuses to overwrite a different startup hook and leaves existing data untouched. `scripts/setup-tv.sh` remains available for optional SSH recovery, but is not required for normal installation.

Before uninstalling, disable launch at start and restore your Home-button mapping in Magic Mapper. The boot symlink targets a file inside the installed package, so uninstalling the package leaves no executable startup target. Keep an independent copy of original wallpapers; resetting or deleting uploads is permanent.

## Phone Home Screen access

Pair with “Remember this phone”, then use the Home Screen help button. On iPhone/iPad, use Safari's Share → Add to Home Screen. On Android, use Chrome's Add to Home screen. Local HTTP may create a shortcut rather than a full PWA. The TV must be reachable and its service running. A different browser/storage context, expired connection or changed TV address can require pairing again.

## Privacy and security

Settings and uploads live under `/var/lib/webosbrew/still-home` on the TV. The companion uses port 1877 on the trusted LAN; it is HTTP, not HTTPS. **Never forward that port to the internet.** Remembered credentials use HttpOnly cookies and hashed server-side records. There is no cloud wallpaper upload or app analytics. Opt-in location search and weather use Open-Meteo; those requests send the entered place name or selected coordinates. The app does not disable or audit LG firmware telemetry.

## Build and test

Use Node.js 18 or later on your development computer:

```sh
npm ci
npm test
npm run build
npm run feed
```

The build produces `dist/com.tomperry.stillhome_0.5.8_all.ipk`. `npm run feed` generates a manifest with its SHA-256 checksum and a one-item Homebrew repository index. Keep the matching IPK and manifest together; rebuild the manifest whenever package bytes change.

`npm run preview` runs an isolated demo on port 1877 with data in `./state`. Open `http://127.0.0.1:1877/tv/index.html?preview=1`. Do not expose demo mode beyond a trusted development machine; its bootstrap is intentionally unauthenticated. Tests create temporary state and do not control a live TV or a virtual machine.

## Attribution and licensing

The QR generator is vendored under its existing MIT license in `app/qr-code.LICENSE.txt`. Weather is provided by [Open-Meteo](https://open-meteo.com/). The remaining application code has no redistribution license assigned yet. This is an independent project, not an LG or webOS Homebrew endorsement. AI tools assisted development; device testing and broader compatibility review remain important before public distribution.
