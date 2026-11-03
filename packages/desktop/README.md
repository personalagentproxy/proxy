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
  the browser too: the web app, which knows the window by its user agent, asks the api for a
  handoff (`POST /auth/desktop/handoff`), an address with a one-time code that signs the browser
  in as the same person and goes on to the service's sign-in, and opens it in the browser. That
  sign-in ends on `/desktop-return`, which hands back through `personalagentproxy://open?path=…`,
  and the window opens the page the sign-in would have ended on. A custom MCP server that asks for
  a sign-in moves its form to the browser, filled in as it was.
- The main process is bundled by `build.ts` into `dist/main.cjs`, the splash pages as text in it.

## Development

```bash
bun run desktop
```

A `bun run dev` already running is used as it is; without one, the stack is started and stopped
again when the window closes. The app loads the root `.env`'s `APP_URL`, the one origin the api
takes sign-ins from. `DESKTOP_APP_URL` names another and skips the stack. A packaged app always
loads hosted Personal Agent Proxy.
