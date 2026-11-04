# @proxy/backends

The backends: what runs the machines Personal Agent Proxy needs for a capability of its own,
behind a contract this package owns. One directory per capability, the sandboxes agents ask for
first (`src/sandbox`): the contract (`backend.ts`), the tests every implementation passes
(`conformance.ts`), the implementation the tests run on (`temp-dir.ts`), a client for one run as
a service elsewhere (`remote.ts`) and what puts any implementation behind that protocol
(`serve.ts`), which is in `@proxy/contracts/sandbox`. The api picks one by its environment
(`packages/api/src/backends`); hosted Personal Agent Proxy runs its own behind the protocol,
outside this repository, as anyone may.
