# @proxy/contracts

What the api answers and takes, as zod schemas, shared with the web app: the api types its
handlers with them and the web app parses answers with them, so neither side retypes the other.
One module per area of the api (`widgets.ts`, `intent.ts`, …), imported as
`@proxy/contracts/<area>`.

Only `zod`, `@proxy/utils` and `@proxy/integrations` may be imported here: nothing of the server,
so the web app's build takes nothing of it. `src/contracts.test.ts` checks it.
