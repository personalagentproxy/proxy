# Personal Agent Proxy for the desktop

A window around the hosted web app, https://app.personalagentproxy.com, with nothing of the web
app or the api in it. The app gives the window, signing in through the browser, and keeps
everything but the app's own origin out of the window: links out of the app open in the browser.

## How it works

- `src/main.ts` starts the app, adds `PersonalAgentProxyDesktop/<version>` to the user agent so the
  web app can tell where it is, and takes the app's links, `personalagentproxy://…`.
- `src/window.ts` loads the web app and keeps the window to it. Where the web app would show its
  login page, the window shows a page of its own with a button that opens the browser; with no
  connection, one that says so. On macOS it hides the native title bar while keeping the traffic
  lights in place; the preload and web app provide the invisible drag surface and content inset.
- Updates (`src/updates.ts`): a new release of the app, checked for on start and every few hours,
  is downloaded at once and announced to the page through the window's preload
  (`src/preload.ts`, `window.personalAgentProxyDesktop` to the web app), which shows its release
  notice with a restart button. Put off, the update is installed when the app next quits.
- Notifications (`src/notifications.ts`): the web app asks for one through the preload, with the
  agent's name, what it said, the page of the app it is on and a tag, one per conversation, when
  an agent answers in Chat while the person is elsewhere and they have turned notifications on;
  the app shows it as the system's, closing the one of the same tag before it, and, clicked,
  focuses the window and hands the page back to the web app, which opens it (the preload goes
  there itself where nothing on the page listens, as on the agents' pages), or loads the page
  where the window has none of the web app's, as on the sign-in and offline pages, or opens a new
  window on it where there is none. The web app sets the count of conversations with something
  unread on the app's badge the same way.
- Signing in (`src/auth.ts`, `packages/api/src/auth/desktop.ts`): the app keeps a PKCE verifier and
  opens the browser at `/login?callbackUrl=/desktop-auth?challenge=…`. Signed in there, the
  `/desktop-auth` page mints a one-time code bound to the challenge and hands it back through
  `personalagentproxy://auth-callback?code=…`. The app trades code and verifier at
  `POST /auth/desktop/session` for a session cookie, which its window keeps, and is signed in as a
  browser is.
- Signing in to Claude (`src/claude-sign-in.ts`, registered in `src/main.ts`): the Account page's
  Claude card asks the app, through the preload, to begin; the app keeps a PKCE verifier and a
  state and opens Claude's sign-in page in the browser, which shows the person a code once they
  have allowed Personal Agent Proxy. Pasted into the card and handed back, the code is checked
  against the attempt and traded for a year's token, the one `claude setup-token` mints, which the
  card connects through the api. The verifier never leaves the main process, and the api mints
  nothing.
- Connecting a service whose sign-in turns the app's window away, as Google's does, happens in
  the browser too: the web app, which knows the window by its user agent, opens the service's
  sign-in in the browser through `/login?callbackUrl=…`, which sends a signed-in browser straight
  on and lets any other sign in as itself first. (The app mints nothing that signs the browser in:
  such a link would sign whoever opened it in as the app's person.) That sign-in ends on
  `/desktop-return`, which hands back through `personalagentproxy://open?path=…`,
  and the window opens the page the sign-in would have ended on. A custom MCP server that asks for
  a sign-in moves its form to the browser, filled in as it was.
- A bank is connected in the window as in the browser: Plaid Link runs in its frame over the page,
  and an OAuth bank's sign-in, which Link opens in a popup that reports back to it, gets a window of
  the app's for that, the one popup that doesn't go to the browser.
- The main process is bundled by `build.ts` into `dist/main.cjs`, the splash pages as text in it.

## Development

```bash
bun run desktop
```

A `bun run dev` already running is used as it is; without one, the stack is started and stopped
again when the window closes. The app loads the root `.env`'s `APP_URL`, the one origin the api
takes sign-ins from. `DESKTOP_APP_URL` names another and skips the stack. A packaged app always
loads hosted Personal Agent Proxy.

## Packaging and releases

```bash
bun run --cwd packages/desktop package
```

Builds the macOS app for Apple silicon and Intel into `release/`: a disk image each to install
from, a zip each for updates, and `latest-mac.yml`, the update feed (`electron-builder.yml`). A
local build uses a Developer ID identity from the Mac's Keychain when one is available, but it is
not notarized without separate Apple credentials and is not a distributable release.

A release is a `desktop-v<version>` tag, with the version in `package.json`:
`.github/workflows/desktop.yml` builds on it and publishes the files as a GitHub release. The app
checks the repository's latest release for `latest-mac.yml` (`src/updates.ts`), so the desktop
app's releases are the repository's releases; the Docker image has tags, not releases. Signing
and notarization are mandatory for a tagged release. The workflow refuses to publish unless it
can verify both architectures' signatures and stapled notarization tickets.

### One-time Apple and GitHub setup

1. Join or renew the Apple Developer Program for the team that will publish Personal Agent Proxy.
2. Use a valid **Developer ID Application** certificate for the team (not an Apple Distribution or
   Developer ID Installer certificate), or have the Apple team's Account Holder create one. On the
   Mac that holds its private key, export the certificate and private key from **My Certificates**
   in Keychain Access as a password-protected `.p12` file.
3. Base64-encode the `.p12` without line breaks:

   ```bash
   base64 -i developer-id-application.p12 | tr -d '\n' | pbcopy
   ```

4. In App Store Connect, open **Users and Access → Integrations → App Store Connect API**, create a
   team key with the **Developer** role, download its `.p8` file, and record its Key ID and Issuer
   ID. Apple only offers the private key for download once.
5. Base64-encode the `.p8` without line breaks:

   ```bash
   base64 -i AuthKey_KEYID.p8 | tr -d '\n' | pbcopy
   ```

6. Add these repository Actions secrets in GitHub under **Settings → Secrets and variables →
   Actions**:

   - `CSC_LINK`: the base64-encoded `.p12`
   - `CSC_KEY_PASSWORD`: the `.p12` export password
   - `APPLE_API_KEY_BASE64`: the base64-encoded `.p8`
   - `APPLE_API_KEY_ID`: the App Store Connect key ID
   - `APPLE_API_ISSUER`: the App Store Connect issuer ID

The certificate and private key files must never be committed. Keep encrypted backups: the `.p8`
cannot be downloaded again, and losing the `.p12` private key means a new Developer ID certificate
is needed for future releases.
