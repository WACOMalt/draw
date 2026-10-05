#!/bin/sh
# Thumbnailer for .bdraw files, for file managers that follow the freedesktop thumbnailer spec
# (KDE Dolphin through KIO, GNOME Files, Nemo, Thunar with tumbler):
#   draw-thumbnailer.sh INPUT OUTPUT [SIZE] [APP]
# A .bdraw file is gzip-compressed JSON (plain JSON also works). Files saved by Draw 0.2.24 or
# later hold a PNG preview ("preview":"data:image/png;base64,...") near the start: this writes
# that PNG to OUTPUT (fast), and the file manager scales it to SIZE. Older files have no
# preview: then APP (the Draw app, AppImage or binary) renders one with `--thumbnail`.
# Without either, the file gets no thumbnail (exit 1) and the file manager shows the icon.
# Only POSIX sh, gzip, head, tr, grep, sed and base64: present on every Linux desktop.

in=$1
out=$2
size=${3:-256}
app=$4
[ -n "$in" ] && [ -n "$out" ] || exit 2

# gzip -dcf passes plain (uncompressed) input through unchanged. The preview is in the first
# few hundred kilobytes; 8 MB is plenty and keeps a huge document from being read in full.
gzip -dcf -- "$in" 2>/dev/null | head -c 8388608 | tr -d '\n' |
  grep -o '"preview":"data:image/png;base64,[A-Za-z0-9+/=]*"' | head -n 1 |
  sed -e 's/^"preview":"data:image\/png;base64,//' -e 's/"$//' |
  base64 -d >"$out" 2>/dev/null

if [ -s "$out" ]; then exit 0; fi
rm -f -- "$out"

# No stored preview: the app renders the drawing.
if [ -n "$app" ] && [ -x "$app" ]; then
  "$app" --thumbnail "$in" "$out" "$size" >/dev/null 2>&1
  if [ -s "$out" ]; then exit 0; fi
  rm -f -- "$out"
fi
exit 1
