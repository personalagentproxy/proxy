# Personal Agent Proxy for the desktop

A window around the hosted web app, https://app.personalagentproxy.com, with nothing of the web
app or the api in it. The app gives the window, signing in through the browser, and keeps
everything but the app's own origin out of the window: links out of the app open in the browser.

## How it works

- `src/main.ts` starts the app, adds `PersonalAgentProxyDesktop/<version>` to the user agent so the
  web app can tell where it is, and takes the app's links, `personalagentproxy://…`.
- `src/window.ts` loads the web app and keeps the window to it. Where the web app would show its
  login page, the window shows a page of its own with a button that opens the browser; with no
  connection, one that says so.
- Signing in (`src/auth.ts`, `packages/api/src/auth/desktop.ts`): the app keeps a PKCE verifier and
  opens the browser at `/login?callbackUrl=/desktop-auth?challenge=…`. Signed in there, the
  `/desktop-auth` page mints a one-time code bound to the challenge and hands it back through
  `personalagentproxy://auth-callback?code=…`. The app trades code and verifier at
  `POST /auth/desktop/session` for a session cookie, which its window keeps, and is signed in as a
  browser is.
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
from, a zip each for updates, and `latest-mac.yml`, the update feed (`electron-builder.yml`).
Without Apple's certificate the app is unsigned, which macOS warns about on first open, and
can't update itself.

A release is a `desktop-v<version>` tag, with the version in `package.json`:
`.github/workflows/desktop.yml` builds on it and publishes the files as a GitHub release. The app
checks the repository's latest release for `latest-mac.yml` (`src/updates.ts`), so the desktop
app's releases are the repository's releases; the Docker image has tags, not releases. Signing
and notarization start once the workflow has `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`,
`APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` as secrets.
