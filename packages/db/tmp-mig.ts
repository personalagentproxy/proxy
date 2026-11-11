import {db, disconnectDb} from './src';
await db.$executeRawUnsafe(
	`UPDATE _prisma_migrations SET migration_name = 'v061_add_entry_attachments' WHERE migration_name = 'v060_add_entry_attachments'`,
);
await db.$executeRawUnsafe(
	`UPDATE _prisma_migrations SET migration_name = 'v060_add_files' WHERE migration_name = 'v059_add_files'`,
);
await disconnectDb();
