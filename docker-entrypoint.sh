#!/bin/sh
# Applies the database migrations, then starts the api.
set -e

if ! bun --bun packages/db/node_modules/.bin/prisma migrate deploy --schema packages/db/prisma/schema.prisma; then
	echo "Applying the database migrations failed. Common causes:"
	echo "  1. The database is not reachable at DATABASE_URL."
	echo "  2. The password in DATABASE_URL has characters that need percent-encoding: @ is %40, : is %3A, / is %2F, # is %23."
	exit 1
fi

exec "$@"
