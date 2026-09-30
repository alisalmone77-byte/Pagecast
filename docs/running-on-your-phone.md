# Running Pagecast on your iPhone

Two routes. The web app takes about five minutes and needs nothing but your
laptop and your phone on the same Wi-Fi. The native app needs a Mac with Xcode.

---

## 1. The web app (five minutes, no Mac required)

The web client is built for this: it installs to the Home Screen, runs
full-screen without Safari's chrome, and does the word-by-word tracking the
product exists for.

### Start the server so your phone can reach it

On your computer:

```sh
git clone https://github.com/alisalmone77-byte/Pagecast.git
cd Pagecast
npm install
npm run build
npm start -w @pagecast/api
```

The server listens on `0.0.0.0:8787`, so it is already reachable from your
network. Find your computer's address on the LAN:

```sh
# macOS
ipconfig getifaddr en0
# Linux
hostname -I | awk '{print $1}'
```

That gives something like `192.168.1.42`.

### Open it on the phone

With your iPhone on the same Wi-Fi, open Safari and go to:

```
http://192.168.1.42:8787
```

Create an account — the first one takes ownership of anything already in the
library. Add a PDF or paste an article link, and press play.

### Add it to the Home Screen

Tap **Share** → **Add to Home Screen**. It gets its own icon and opens
full-screen with no address bar. (The app shows this hint itself the first time
you open it in Safari on a phone.)

### What works, and what doesn't

Working: the whole reading experience — ingestion, synthesis, word-level
highlighting, sentence tinting, tap-a-word-to-jump, speed up to 4.5×, all three
themes, OpenDyslexic, folders, and sync with your desktop.

Two honest limits over plain `http://` on a LAN:

- **No offline caching.** Browsers only register a service worker in a secure
  context, so `http://192.168.x.x` gets no offline shell and no cached audio.
  Everything still works while you are on the Wi-Fi.
- **Audio stops when you leave the app.** iOS suspends an `AudioContext` when
  Safari is backgrounded. The lock-screen controls and now-playing metadata are
  wired up and correct, but sustained playback with the screen off is what the
  native client is for.

Both limits come from the plain-http origin and from Web Audio, not from the
app. If you want the installed experience properly, put it behind HTTPS.

### Optional: HTTPS, so offline caching works

Any tunnel that terminates TLS will do. With Cloudflare Tunnel:

```sh
cloudflared tunnel --url http://localhost:8787
```

It prints an `https://…trycloudflare.com` address. Open that on the phone
instead, and set `PAGECAST_SECURE_COOKIES=true` when starting the server:

```sh
PAGECAST_SECURE_COOKIES=true npm start -w @pagecast/api
```

That flag matters. Over HTTPS the session cookie should carry `Secure`; over
plain http it must not, or the browser drops it and every request looks signed
out. It is off by default so the LAN route above works.

> A tunnel puts your library on a public URL. It is protected by your password,
> but the URL is reachable by anyone who has it. Set
> `PAGECAST_ALLOW_REGISTRATION=false` once your account exists, so nobody else
> can sign up on your server.

---

## 2. The native app (needs a Mac with Xcode)

**These sources have not been compiled.** They were written in a Linux container
with no Swift toolchain, so expect to fix some diagnostics on the first build.
`apps/ios/README.md` lists what has been verified and what has not.

```sh
brew install xcodegen
cd apps/ios
xcodegen generate
open Pagecast.xcodeproj
```

Then, in Xcode:

1. **Point the app at your server.** Edit `PAGECAST_API_BASE` in
   `Pagecast/Info.plist` and in `PagecastShareExtension/Info.plist`. Use your
   computer's LAN address (`http://192.168.1.42:8787`) for a physical device;
   `http://localhost:8787` works in the simulator.
2. **Set your signing team.** Select the *Pagecast* target → Signing &
   Capabilities → Team. Do the same for *PagecastShareExtension*.
3. **Fix the bundle identifiers.** `com.pagecast.app` is almost certainly taken.
   Change it to something of your own (`com.yourname.pagecast`) on both targets,
   keeping the extension as `<app id>.share`.
4. **Update the keychain group.** Both targets share one so the Safari share
   extension can use your session. Edit `keychain-access-groups` in both
   `.entitlements` files to match your prefix, or sharing from Safari will say
   you need to sign in.
5. Select your iPhone as the destination and press Run.

### If you are using a free Apple ID

It works, with three things to know:

- The provisioning profile expires after **seven days**. After that the app
  stops launching until you rebuild from Xcode.
- A free account allows **three app IDs**, and the share extension uses one of
  them. If you hit the limit, delete the `PagecastShareExtension` target from
  `project.yml`, regenerate, and build the app alone — everything except
  sharing from Safari still works.
- Keychain sharing needs the entitlement on both targets. If signing complains,
  the quickest fix is the same: drop the extension and build the app alone.

### Trusting the developer certificate

The first launch fails with "Untrusted Developer". On the phone: **Settings →
General → VPN & Device Management → Developer App →** trust your certificate,
then launch again.

### Plain http to your Mac

`NSAllowsLocalNetworking` is already set in both plists so a development server
over http works. A production build talks to HTTPS and should drop that key.

---

## Which one should you use?

If you want to *see it working today*, use the web app — it is the same reader,
the same sync, and the same highlighting, and it takes five minutes.

Reach for the native app when you want the things only it can do: background
playback with the screen off, the camera scanner for printed pages, and the
Safari share sheet.
