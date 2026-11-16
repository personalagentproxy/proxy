import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {startPrismaDevServer} from '@prisma/dev';

const server = await startPrismaDevServer({
	name: 'environment-e2e-' + process.pid,
	persistenceMode: 'stateless',
	port: 55413,
	databasePort: 55414,
	shadowDatabasePort: 55415,
	streamsPort: 55416,
});
process.env.DATABASE_URL =
	server.database.prismaORMConnectionString ?? server.database.connectionString;
process.env.APP_URL = 'http://localhost:55420';
process.env.NODE_ENV = process.argv.includes('--serve') ? 'development' : 'test';
process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');
const migrate = Bun.spawn(
	[
		'bun',
		'packages/db/node_modules/.bin/prisma',
		'migrate',
		'deploy',
		'--schema',
		'packages/db/prisma/schema.prisma',
	],
	{env: process.env, stdout: 'pipe', stderr: 'pipe'},
);
const migrationCode = await migrate.exited;
if (migrationCode !== 0) {
	console.error(await new Response(migrate.stderr).text());
	await server.close();
	process.exit(1);
}
console.log('All migrations applied to isolated database');
const {db} = await import('../src');
const {createHttpApp} = await import('../../api/src/server/create-http-app');
const httpApp = createHttpApp();
let browserCookie = '';
const app = createServer((req, res) => {
	if (process.argv.includes('--serve') && req.url === '/test-login') {
		res.writeHead(302, {
			'Set-Cookie': browserCookie + '; Path=/; HttpOnly; SameSite=Lax',
			Location: '/env-e2e/environments',
		});
		res.end();
		return;
	}
	httpApp(req, res);
}).listen(55420);
const origin = 'http://localhost:55420';
const owner = await db.user.create({data: {email: 'owner@example.test'}});
const org = await db.organization.create({
	data: {
		name: 'Example',
		slug: 'env-e2e',
		onboardedAt: new Date(),
		ownerUserId: owner.id,
		members: {create: {userId: owner.id}},
	},
});
const token = randomBytes(32).toString('hex');
await db.session.create({
	data: {
		userId: owner.id,
		tokenHash: createHash('sha256').update(token).digest('hex'),
		expires: new Date(Date.now() + 60000),
	},
});
const humanCookie = 'proxy.session-token=' + token;
browserCookie = humanCookie;
const agent = await db.agent.create({
	data: {
		orgId: org.id,
		name: 'Example agent',
		username: 'environment-e2e-agent',
		providerId: 'claude-code',
		passwordHash: await Bun.password.hash('invented-password'),
	},
});
async function call(path: string, method = 'GET', body?: object, cookie = humanCookie) {
	return fetch(origin + path, {
		method,
		headers: {Origin: origin, Cookie: cookie, 'Content-Type': 'application/json'},
		...(body ? {body: JSON.stringify(body)} : {}),
	});
}
if (process.argv.includes('--serve')) {
	console.log('Isolated UI server ready at http://localhost:55420');
	await new Promise<void>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	app.close();
	await db.$disconnect();
	await server.close();
	process.exit(0);
}
const base = '/api/orgs/env-e2e/environments/development/example';
assert.equal(
	(await call(base, 'PUT', {PUBLIC: 'example-value', SECRET: 'private-value'})).status,
	200,
);
const saved = await db.developmentEnvironment.findFirstOrThrow();
assert.ok(!saved.ciphertext.includes('private-value'));
const login = await call(
	'/agent-auth/login',
	'POST',
	{username: agent.username, password: 'invented-password'},
	'',
);
assert.equal(login.status, 200);
const agentCookie = login.headers
	.getSetCookie()
	.map((value) => value.split(';')[0])
	.join('; ');
const runtime = '/api/agent/environments/development/example';
assert.equal((await call(runtime, 'GET', undefined, '')).status, 401);
assert.equal((await call(runtime, 'GET', undefined, agentCookie)).status, 403);
assert.equal(
	(await call(base + '/grants', 'PUT', {agentId: agent.id, names: ['PUBLIC']})).status,
	200,
);
const granted = await call(runtime, 'GET', undefined, agentCookie);
assert.equal(granted.headers.get('cache-control'), 'no-store');
assert.deepEqual(await granted.json(), {variables: {PUBLIC: 'example-value'}});
assert.equal((await call(base, 'PUT', {SECRET: 'private-value'})).status, 200);
assert.equal((await call(base, 'PUT', {PUBLIC: 'new-value'})).status, 200);
assert.equal((await call(runtime, 'GET', undefined, agentCookie)).status, 403);
assert.equal(
	(await call(base + '/grants', 'PUT', {agentId: agent.id, names: ['PUBLIC']})).status,
	200,
);
await db.agent.update({where: {id: agent.id}, data: {revokedAt: new Date()}});
assert.equal((await call(runtime, 'GET', undefined, agentCookie)).status, 401);
const audit = await db.environmentAccess.findMany();
assert.ok(audit.length >= 3);
assert.ok(!JSON.stringify(audit).includes('private-value'));
await db.organization.delete({where: {id: org.id}});
assert.equal(await db.developmentEnvironment.count(), 0);
assert.equal(await db.environmentAccess.count(), 0);
console.log(
	'HTTP authentication, encryption, explicit grants, variable removal, revocation and cascades passed',
);
app.close();
await db.$disconnect();
await server.close();
