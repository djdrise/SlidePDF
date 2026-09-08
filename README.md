# SlidePDF

**English** · [Русский](README.ru.md)

[![Latest release](https://img.shields.io/github/v/release/djdrise/SlidePDF?label=release)](https://github.com/djdrise/SlidePDF/releases/latest)
[![Check](https://github.com/djdrise/SlidePDF/actions/workflows/check.yml/badge.svg)](https://github.com/djdrise/SlidePDF/actions/workflows/check.yml)
[![License: GPL-3.0](https://img.shields.io/badge/license-GPL--3.0-blue)](LICENSE)

A cross-platform PDF viewer for conference talks: the slide goes to the
projector, while your laptop keeps a presenter view with the slide order, the
next slide and the text of the current one. Several decks open as tabs. The
interface is light and deliberately plain.

macOS · Windows · Linux (Electron + pdf.js).

![Presenter view: current slide, next slide, slide text and the thumbnail strip](docs/screenshot.png)

## Install

Prebuilt installers are on the
[Releases](https://github.com/djdrise/SlidePDF/releases) page: `.dmg` for macOS
(Apple Silicon and Intel separately), `.exe` for Windows (installer and
portable), `.AppImage` and `.deb` for Linux.

The builds are not code-signed, so the first launch needs a nudge:

* **macOS** — right-click the app → “Open”, then confirm. A plain double-click
  is blocked by Gatekeeper.
* **Windows** — SmartScreen warns: “More info” → “Run anyway”.
* **Linux** — make the AppImage executable: `chmod +x SlidePDF-*.AppImage`.

## Running from source

Node.js 20 or newer.

```bash
npm install
npm start                 # or: npm start -- path/to/deck.pdf
npm run dev               # same, plus renderer logs in the terminal
```

> `npm start` goes through `scripts/start.js`. The VS Code terminal exports
> `ELECTRON_RUN_AS_NODE=1`, and with it the Electron binary starts as plain
> Node and the app crashes. The launcher clears that variable.

## Checks

```bash
npm run check     # syntax check across all sources
```

There are no tests: nearly all of the code is window, display and rendering
work that only makes sense to verify by running it. `npm run check` catches
typos before startup, and GitHub Actions runs the same command.

## Building installers

```bash
npm run dist:mac      # dmg + zip
npm run dist:win      # nsis + portable
npm run dist:linux    # AppImage + deb
```

electron-builder only builds for the host OS: cross-building for Windows needs
wine, and Linux builds are not supported on macOS. Releases are therefore built
on GitHub Actions — one job per OS. The
[`release.yml`](.github/workflows/release.yml) workflow fires on a `v*` tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

## How the screens work

The audience window does not appear on startup at all — only on “Present”
(<kbd>F5</kbd>), and it leaves the screen once the show ends. To see beforehand
what the room will see, open it by hand: “Show / hide audience window” in the
menu.

The app picks the screen for the show on its own:

* **An external screen is present** — the slide goes there, the presenter view
  stays on the built-in display.
* **A single screen** — the show covers the presenter window.
* A projector plugged in or unplugged mid-talk — `display-added` /
  `display-removed` rebuild the layout on the fly, and a running show moves to
  the right screen without a break. Plugging one in does not start a show.
* The automation can be overridden: the gear in the header opens settings with
  a list of screens, where you pick the one the slide goes to. After a manual
  choice the automation stops reassigning the show screen — until that monitor
  is disconnected.

Both windows render the PDF independently from the same bytes, while the state —
current slide, black screen, active tab — lives in the main process and is
broadcast to both. The audience window cannot fall behind the presenter view.

## The show

Starts and ends with <kbd>F5</kbd>. The audience window is created without a
frame (`frame: false`), so nothing but the slide is on screen; in preview mode
(single display) it gets its own title strip instead of the system frame, so it
can still be dragged.

The show appears already finished. While the window geometry changes it is kept
transparent, and it is only revealed once the renderer confirms it has redrawn
the slide at the new size. Otherwise the audience would watch the window stretch
out of its preview size while the slide caught up. On macOS the show uses
`simpleFullScreen` so that no separate Space is created with its transition
animation.

Focus moves to the full-screen window immediately, so a presenter remote and the
keyboard act on the show. The mouse cursor hides there — instantly on start, and
again two seconds after the mouse stops moving.

## Presenter view

* Several decks open as tabs: <kbd>Ctrl</kbd>+<kbd>Tab</kbd> forward,
  <kbd>Shift</kbd>+<kbd>Tab</kbd> back, the cross on a tab or
  <kbd>Cmd/Ctrl</kbd>+<kbd>W</kbd> to close. Each tab remembers its own page;
  the open dialog and drag-and-drop both accept several files at once.
* The current slide is large, the next one sits beside it.
* **Slide order**: a thumbnail strip at the bottom and a full-screen grid of
  every slide (<kbd>G</kbd>). In the grid the arrows move the selection without
  touching the audience screen; <kbd>Enter</kbd> or a click jumps there.
* The text of the current slide stands in for speaker notes.
* The slide counter and the screen indicator both appear only when they have
  something to say.

## Keys

| Key | Action |
| --- | --- |
| <kbd>→</kbd> <kbd>↓</kbd> <kbd>Space</kbd> <kbd>PageDown</kbd> | next slide |
| <kbd>←</kbd> <kbd>↑</kbd> <kbd>PageUp</kbd> <kbd>Backspace</kbd> | previous slide |
| <kbd>Home</kbd> / <kbd>End</kbd> | first / last slide |
| digits, then <kbd>Enter</kbd> | jump to a slide by number |
| <kbd>G</kbd> | grid of all slides |
| <kbd>Ctrl</kbd>+<kbd>Tab</kbd> / <kbd>Shift</kbd>+<kbd>Tab</kbd> | next / previous tab |
| <kbd>B</kbd> | black out the audience screen |
| <kbd>F5</kbd> | start / end the show |
| <kbd>O</kbd> | open a PDF |
| <kbd>Esc</kbd> | close the grid, clear the black screen, end the show |

Both windows listen for keys, so a presenter remote (which sends
PageUp/PageDown) works no matter which window has focus. The layout also
recognises the Cyrillic letters on the same physical keys.

## Logo

The mark is a deck of slides: three same-sized cards fanned diagonally. The tile
is coral — in a taskbar where almost everything is blue and grey, a warm colour
stands out.

```
assets/logo.svg        the mark for the interface (two-tone, on a light background)
assets/icon.svg        the app icon — a white mark on a blue tile
assets/icon-small.svg  a simplified mark for the small icon sizes
assets/icon.png        1024×1024, electron-builder turns it into .icns for macOS
assets/icon.ico        16…256 for Windows, built here
```

`npm run icon` rebuilds both images from the SVGs using Chromium: a standalone
SVG converter may be missing from the system, while Electron is already
installed. The script bootstraps itself — under plain Node it re-spawns itself
in Electron.

The Windows `.ico` is built here rather than left to electron-builder: that one
squeezes a single 1024×1024 image down to every size at once, and a 64× downscale
smears the detail away. Here each size is rasterised from the vector separately,
at its natural size, and 16, 24 and 32 pixels come from `icon-small.svg`: two
cards instead of three and a larger offset, because at 16 pixels the third card
shifts by less than a pixel and merges with its neighbour.

## Layout

```
src/main/main.js        displays, windows, show state, menu
src/preload/preload.js  contextBridge: commands, subscriptions, drag-and-drop paths
src/renderer/
  presenter.*           presenter view
  audience.*            audience screen
  lib/pdfview.js        pdf.js wrapper: document, fitted slide, thumbnails
  lib/keys.js           shared key bindings and drag-and-drop
scripts/start.js        launcher that clears ELECTRON_RUN_AS_NODE
scripts/make-icon.js    builds assets/icon.png from assets/icon.svg
scripts/check.js        syntax check across the sources
assets/                 logo and application icon
docs/                   screenshot for the README
```

The windows are isolated: `contextIsolation: true`, `nodeIntegration: false`,
and the CSP forbids every network request — a PDF with external links loads
nothing.

> Source comments are written in Russian.

## License

GNU General Public License v3.0 or later — full text in [LICENSE](LICENSE).

> SlidePDF is free software: you can redistribute it and/or modify it under
> the terms of the GNU General Public License as published by the Free Software
> Foundation, either version 3 of the License, or (at your option) any later
> version. It is distributed in the hope that it will be useful, but WITHOUT ANY
> WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
> A PARTICULAR PURPOSE. See the GNU General Public License for more details.

Third-party components: [pdf.js](https://github.com/mozilla/pdf.js) (Apache-2.0)
and [Electron](https://github.com/electron/electron) (MIT).
