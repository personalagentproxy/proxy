# @proxy/backends

The backends: what runs the machines Personal Agent Proxy needs for a capability of its own,
behind a contract this package owns. One directory per capability, the sandboxes agents ask for
first (`src/sandbox`): the contract (`backend.ts`), the tests every implementation passes
(`conformance.ts`), the implementation the tests run on (`temp-dir.ts`), and a client for one run
as a service elsewhere (`remote.ts`), over the protocol in `@proxy/contracts/sandbox`. The api
picks one by its environment (`packages/api/src/backends`); hosted Personal Agent Proxy runs its
own as a service outside this repository, as anyone may who answers the protocol.

The second capability is the harness (`src/harness`): the loop that runs one turn of the built-in
Chat agent's model on one thread's log, so that the loop can be swapped. The contract
(`backend.ts`) gives a harness the log, the system prompt and the tools as the api built them, and
takes back what the model did as a stream of events; the api keeps everything around a turn. The
tests every harness passes are in `conformance.ts`, driven by a scripted model, and `fake.ts` is
the scripted harness the api's tests run on. The first harness, the api's own loop over
OpenRouter, is in the api (`packages/api/src/harness/proxy-harness.ts`).
