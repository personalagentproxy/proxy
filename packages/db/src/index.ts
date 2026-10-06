import {PrismaClient} from '@prisma/client';

const globalForPrisma = globalThis as unknown as {
	prisma: PrismaClient | undefined;
};

// Caps Prisma's pool, which defaults to num_cpus * 2 + 1, unless the URL sets its own limit (the
// dev database takes one connection).
function buildPrismaDatasourceUrl(): string | undefined {
	const raw = process.env.DATABASE_URL;
	if (!raw) {
		return undefined;
	}

	if (!URL.canParse(raw)) {
		return raw;
	}

	const url = new URL(raw);
	if (!url.searchParams.has('connection_limit')) {
		url.searchParams.set('connection_limit', '5');
	}
	if (!url.searchParams.has('pool_timeout')) {
		url.searchParams.set('pool_timeout', '20');
	}
	return url.toString();
}

const prismaUrl = buildPrismaDatasourceUrl();

export const db =
	globalForPrisma.prisma ??
	new PrismaClient({
		log: ['error', 'warn'],
		...(prismaUrl ? {datasources: {db: {url: prismaUrl}}} : {}),
	});

globalForPrisma.prisma = db;

/** Eagerly opens the connection pool so boot fails fast on a bad DATABASE_URL. */
export function connectDb(): Promise<void> {
	return db.$connect();
}

/** Drains the connection pool; part of graceful shutdown. */
export function disconnectDb(): Promise<void> {
	return db.$disconnect();
}

export {Prisma} from '@prisma/client';
