# QueueUp

A local Windows desktop app for running a viewer queue on stream. Twitch chat integration,
drag-and-drop party management, live wait timers, and a transparent OBS overlay.

No command prompt, no browser tab — it's a real app window.

---

## Install

**Option A — installer**

Run `dist\QueueUp Setup 1.0.0.exe`. It creates a desktop shortcut and a Start menu entry.

**Option B — portable**

Run `dist\win-unpacked\QueueUp.exe` directly. No install needed.

**Option C — from source**

```bash
npm install && npm start
```

To rebuild the installer after code changes:

```bash
npm run dist
```

---

## Connecting Twitch

Open **Settings** and click **Log in with Twitch**. Your browser opens, you log in on Twitch's
own page, and QueueUp picks it up on its own.

That's the whole setup. No account to register, no developer console, nothing to copy or paste.
Your channel name is detected from the login, so there's nothing to type either.

QueueUp keeps you logged in and renews the session by itself in the background. If it ever
can't, it says so on launch and one click puts it right.

Everything runs on your PC. The credential is stored in a local file beside your queue and does
exactly one thing: open a chat connection from your machine to Twitch. Nothing is sent anywhere
else and there is no server in the middle. Revoke it any time from
[Twitch → Connections](https://www.twitch.tv/settings/connections).

### Without logging in

QueueUp can also watch any channel's chat anonymously — it just can't talk back. Expand
**Read chat without signing in** in Settings, type a channel name, and hit Connect.

---

## Chat commands

| Command | What it does |
| --- | --- |
| `!join` | Queues the viewer who typed it |
| `!dequeue` | Removes them from the queue |
| `!queue` | Posts the whole queue in chat |

All three are renameable in Settings → Queue rules.

`!queue` posts exactly this, with a star on every subscriber:

```
Queue (10): 1. lovediddyo⭐, 2. jeffunderdog⭐, 3. fizzyzayizbetter, 4. rydu9, 5. westondemond, 6. dabeezy46, 7. jayaunaa12, 8. bob396978, 9. limit_luke, 10. rhysszn⭐
```

Twitch caps messages at 500 characters, so a long queue is trimmed to `… +N more`
instead of being cut off mid-name. `!queue` is rate-limited to one post every 8 seconds
so it can't be used to flood your chat.

**Posting in chat requires signing in** (below) — reading chat doesn't.

**Subscribers skip the line.** A sub who types `!join` is inserted ahead of every non-sub,
but behind subs who were already waiting — so it's fair within each tier. Subs get a `SUB`
badge in the app and on the overlay. Toggle this off in Settings → Queue rules.

---

## Using the queue

**Party** is who's in your game — 3 viewers plus you by default (change the size in Settings).
**Queue** is everyone waiting, with a live timer showing exactly how long they've been in line.

- **Drag any player** between and within both lists. Drop a queued player onto a party slot to
  pull them in; drag a party member back down to return them to the queue.
- If the party is full and you drag someone in anyway, the last party member is bumped back to
  the front of the queue.
- **↑ / ↓** buttons do the same thing in one click.
- **✕** removes a player entirely.
- **Fill Party** pulls the next players up to fill open slots.
- **Next Game** clears the party and pulls in the next group.
- **Ctrl+K** jumps to the manual add box.

Timers count up from the moment someone joined, are accurate to the second, and survive
restarting the app. Over 10 minutes turns amber, over 25 turns red. A player sent back from the
party gets a fresh clock.

The whole queue is saved to disk automatically, so closing the app doesn't lose anyone.

---

## OBS overlay

Open the **Overlay** tab, click **Copy browser source URL**, then in OBS:

**Sources → + → Browser →** paste the URL. Use the width/height shown under the preview and
leave *Shutdown source when not visible* **unchecked**.

The background is genuinely transparent — only the rows render. It shows people **in the queue
only**; anyone you pull into the party disappears from it automatically.

Everything is customizable live from the app, with a preview right next to the controls:
header text, how many players show, three row styles (cards / bars / minimal), top-down or
bottom-up stacking, left or right alignment, width, scale, spacing, corner radius, all colors,
row opacity, font and weight, plus toggles for rank numbers, avatars, wait timers, first-place
highlighting, glow, and the shimmer sweep. Animation speed is adjustable too.

Changes push to OBS instantly over a websocket — no refreshing the source.

Players sliding in, dropping out, and moving position are all animated.

---

## Updates

On launch QueueUp shows a brief **Checking for updates…** screen. If you're current it fades
straight into the app. If there's a new version it downloads right there with a progress bar,
then offers **Restart & install** (or **Later**, if you're about to go live).

Settings → Updates also has a manual check, and a toggle to skip the launch check entirely.

Updates only apply to the installed app — running from source, the updater sits idle.

### Publishing a new version (for me/you later)

1. Bump `version` in `package.json`.
2. Commit and push.
3. Set a GitHub token with `repo` scope, then:

```bash
npm run release
```

That builds the installer and publishes it as a GitHub release. Everyone running QueueUp picks
it up the next time they open the app.

---

## Notes

- The overlay server runs on `localhost:4747`, bound to your machine only — nothing is exposed
  to the internet. If that port is taken the app picks a free one and updates the URL for you.
- Changing the port in Settings needs an app restart.
- Avatars are generated from each viewer's name. Real Twitch profile pictures appear
  automatically once you've signed in (they need a Client ID to fetch).
- App state lives at `%APPDATA%\QueueUp\queueup-state.json`.

## Layout

```
electron/   main process — window, IPC, Twitch IRC client, queue state
app/        the desktop UI (Queue / Overlay / Settings tabs)
overlay/    the transparent OBS browser source
assets/     app icon
```
