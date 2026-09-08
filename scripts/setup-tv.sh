#!/bin/sh
# Run on a rooted TV after installing the IPK. Only Still Home is changed.
set -eu
service=/media/developer/apps/usr/palm/services/com.tomperry.stillhome.service
hook=/var/lib/webosbrew/init.d/60-still-home
elevate=/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/elevate-service
test "$(id -u)" = 0 || { echo 'Run as root on the TV.' >&2; exit 1; }
test -x "$elevate" && test -x "$service/autostart.sh"
if [ -e "$hook" ] || [ -L "$hook" ]; then
  test -L "$hook" && test "$(readlink "$hook")" = "$service/autostart.sh" || { echo 'Existing startup hook differs; refusing to overwrite it.' >&2; exit 1; }
fi
"$elevate" com.tomperry.stillhome.service
mkdir -p /var/lib/webosbrew/init.d
if [ ! -L "$hook" ]; then ln -s "$service/autostart.sh" "$hook"; fi
echo 'Setup complete. Open Still Home from the TV app list. Launch at start defaults off.'
