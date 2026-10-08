import {startPrismaDevServer} from '@prisma/dev';
const server = await startPrismaDevServer({
	name: 'migration-check',
	persistenceMode: 'stateless',
	port: 52310,
	databasePort: 52311,
	shadowDatabasePort: 52312,
	streamsPort: 52313,
});
console.log('ready');
process.on('SIGTERM', async () => {
	await server.close();
	process.exit(0);
});
await new Promise(() => {});
