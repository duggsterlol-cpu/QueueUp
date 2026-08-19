# HamQueue

A local Windows desktop app for running a viewer queue on stream. Twitch chat integration,
drag-and-drop party management, live wait timers, and a transparent OBS overlay.

No command prompt, no browser tab — it's a real app window.

---

## Install

**Option A — installer**

Run `dist\HamQueue Setup 1.0.0.exe`. It creates a desktop shortcut and a Start menu entry.

**Option B — portable**

Run `dist\win-unpacked\HamQueue.exe` directly. No install needed.

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

1. Open **Settings** → type your channel name (just `yourname`, not the full URL).
2. Hit **Connect**.

That's it. Reading chat uses Twitch's anonymous read-only connection, so there's **no login,
no token, no Twitch app to register**. It reconnects on its own if your internet blips.

### Sign in so your account replies in chat

Reading chat works anonymously, but *speaking* needs an account. Sign in with your own Twitch
account and HamQueue posts as you:

- `!join` → "@viewer you've been added to the queue — you're #4."
- `!dequeue` → "@viewer you've been removed from the queue."
- `!queue` → the full numbered list above.

To set it up:

1. Go to <https://dev.twitch.tv/console/apps/create>
2. Name: anything. Category: **Chat Bot**.
3. OAuth Redirect URL: `http://localhost:4747/auth/callback` (there's a copy button in Settings)
4. Create → **Manage** → copy the Client ID into Settings.
5. Click **Sign in with Twitch** and approve it in your browser.

Signing in turns on **Reply to viewers in chat** automatically; the toggle in Settings turns
replies off again without signing out.

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

## Notes

- The overlay server runs on `localhost:4747`, bound to your machine only — nothing is exposed
  to the internet. If that port is taken the app picks a free one and updates the URL for you.
- Changing the port in Settings needs an app restart.
- Avatars are generated from each viewer's name. Real Twitch profile pictures appear
  automatically once you've signed in (they need a Client ID to fetch).
- App state lives at `%APPDATA%\HamQueue\hamqueue-state.json`.

## Layout

```
electron/   main process — window, IPC, Twitch IRC client, queue state
app/        the desktop UI (Queue / Overlay / Settings tabs)
overlay/    the transparent OBS browser source
assets/     app icon
```
