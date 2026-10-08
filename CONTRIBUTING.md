# Contributing

Thanks for helping improve Personal Agent Proxy.

## Set up the project

You need [Git](https://git-scm.com/), [Node.js](https://nodejs.org/), and [Bun](https://bun.sh/).

```sh
git clone https://github.com/personalagentproxy/proxy.git
cd proxy
bun install
cp .env.example .env
bun run dev
```

The development command starts the local database, API, web app, documentation, and website. Open:

- Web app: <http://localhost:5173>
- Documentation: <http://localhost:5174>
- Website: <http://localhost:5175>

To fill the local database with a demo workspace, leave the development processes running and use another terminal:

```sh
bun run seed
```

## Optional repository tooling

To configure the repository's formatting hook and link its AI skills into `.claude/skills` and `.codex/skills`, run:

```sh
bun run setup
```

This replaces those two local skill paths with symlinks to the repository's `skills` directory.

## Make a change

Keep changes focused and include tests or documentation when behavior changes. Before opening a pull request, run:

```sh
bun run typecheck
bun run test
bun run lint
bun run build
```

The optional pre-commit hook formats staged files with Prettier.

## Database migrations

With the local database running, update `packages/db/prisma/schema.prisma`, then generate the migration SQL:

```sh
bun run --cwd packages/db db:migrate:diff
```

Save the output as `packages/db/prisma/migrations/<name>/migration.sql`, named `v` and the next three-digit number, such as `v010_add_x`. Prisma applies migrations in the order their names sort as text, so a name like `10_add_x` would run before older ones; a test refuses it. Pending migrations run when `bun run dev` starts.

## Open a pull request

Describe what changed and why, keep the pull request scoped to one concern, and include screenshots for visible interface changes.
