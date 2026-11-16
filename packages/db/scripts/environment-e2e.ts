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
	for (const [name, service, label] of [
		['OPENAI_API_KEY', 'OpenAI', 'API key'],
		['STRIPE_SECRET_KEY', 'Stripe', 'Secret key'],
		['CLERK_SECRET_KEY', 'Clerk', 'Secret key'],
	]) {
		await call('/api/orgs/env-e2e/environments/development/example-development/keys', 'PUT', {
			name,
			service,
			label,
			value: 'invented-demo-value',
		});
	}
	await db.session.updateMany({data: {expires: new Date(Date.now() + 3600000)}});
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
const member = await db.user.create({data: {email: 'member@example.test'}});
await db.orgMember.create({data: {userId: member.id, orgId: org.id}});
const memberToken = randomBytes(32).toString('hex');
await db.session.create({
	data: {
		userId: member.id,
		tokenHash: createHash('sha256').update(memberToken).digest('hex'),
		expires: new Date(Date.now() + 60000),
	},
});
const memberCookie = 'proxy.session-token=' + memberToken;
// Workspace images are owner-managed and readable by members, never arbitrary HTML/SVG.
const imagePath = '/api/orgs/env-e2e/image';
const sampleImage =
	'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNw6TgDAAKsAZkaoN/PAAAAAElFTkSuQmCC';
assert.equal((await call(imagePath, 'PUT', {image: sampleImage}, memberCookie)).status, 403);
assert.equal(
	(await call(imagePath, 'PUT', {image: 'data:image/svg+xml;base64,PHN2Zy8+'})).status,
	400,
);
assert.equal((await call(imagePath, 'PUT', {image: 'data:image/png;base64,YmFk'})).status, 400);
assert.equal((await call(imagePath, 'PUT', {image: sampleImage})).status, 200);
const withImage = await (await call('/api/orgs/env-e2e', 'GET', undefined, memberCookie)).json();
assert.ok(withImage.image.startsWith('data:image/webp;base64,'));
const workspaceList = await (await call('/api/orgs')).json();
assert.equal(
	workspaceList.orgs.find((item: {slug: string}) => item.slug === 'env-e2e').image,
	withImage.image,
);
assert.equal((await call(imagePath, 'PUT', {image: null})).status, 200);
const withoutImage = await (await call('/api/orgs/env-e2e')).json();
assert.ok(!withoutImage.image);

assert.equal((await call(base, 'PUT', {PUBLIC: 'forbidden'}, memberCookie)).status, 403);
assert.equal(
	(await call('/api/orgs/env-e2e/environments/development', 'GET', undefined, memberCookie)).status,
	403,
);
assert.equal(
	(await call('/api/orgs/env-e2e/environments/access', 'GET', undefined, memberCookie)).status,
	403,
);
assert.equal(
	(
		await fetch(origin + base, {
			method: 'PUT',
			headers: {
				'Content-Type': 'application/json',
				Origin: 'https://untrusted.example',
				Cookie: humanCookie,
			},
			body: '{"PUBLIC":"forbidden"}',
		})
	).status,
	403,
);
const otherOrg = await db.organization.create({
	data: {name: 'Other', slug: 'other', ownerUserId: member.id},
});
const foreignAgent = await db.agent.create({
	data: {
		orgId: otherOrg.id,
		name: 'Other agent',
		username: 'other-agent',
		providerId: 'claude-code',
		passwordHash: await Bun.password.hash('invented-password'),
	},
});

assert.equal(
	(await call(base, 'PUT', {PUBLIC: 'example-value', SECRET: 'private-value'})).status,
	200,
);
const saved = await db.developmentEnvironment.findFirstOrThrow();
assert.ok(!saved.ciphertext.includes('private-value'));
assert.equal(
	(await call(base + '/grants', 'PUT', {agentId: foreignAgent.id, names: ['PUBLIC']})).status,
	403,
);
const otherLogin = await call(
	'/agent-auth/login',
	'POST',
	{username: foreignAgent.username, password: 'invented-password'},
	'',
);
const otherCookie = otherLogin.headers
	.getSetCookie()
	.map((value) => value.split(';')[0])
	.join('; ');
assert.equal(
	(await call('/api/agent/environments/development/example', 'GET', undefined, otherCookie)).status,
	403,
);
await db.organization.delete({where: {id: otherOrg.id}});

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

// Service-based human sharing, metadata, exact statistics and revocation.
const overviewPath = '/api/orgs/env-e2e/environments/overview';
assert.equal(
	(
		await call(base + '/keys', 'PUT', {
			name: 'OPENAI_API_KEY',
			value: 'invented-openai-value',
			service: 'OpenAI',
			label: 'API key',
		})
	).status,
	200,
);
assert.equal(
	(
		await call(base + '/keys', 'PUT', {
			name: 'STRIPE_SECRET_KEY',
			value: 'invented-stripe-value',
			service: 'Stripe',
			label: 'Secret key',
		})
	).status,
	200,
);
assert.equal(
	(
		await call(base + '/keys', 'PUT', {
			name: 'OPENAI_API_KEY',
			service: 'OpenAI',
			label: 'Development API key',
		})
	).status,
	200,
);
assert.equal(
	(
		await call(
			base + '/keys',
			'PUT',
			{name: 'OTHER', value: 'forbidden', service: 'Other', label: 'Other'},
			memberCookie,
		)
	).status,
	403,
);
assert.equal(
	(await call(base + '/reveal', 'POST', {names: ['OPENAI_API_KEY']}, memberCookie)).status,
	403,
);
assert.equal(
	(
		await call(base + '/sharing', 'PUT', {
			kind: 'person',
			id: member.id,
			scope: ['OPENAI_API_KEY'],
			names: ['OPENAI_API_KEY'],
		})
	).status,
	200,
);
assert.equal(
	(
		await call(base + '/sharing', 'PUT', {
			kind: 'person',
			id: member.id,
			scope: ['STRIPE_SECRET_KEY'],
			names: ['STRIPE_SECRET_KEY'],
		})
	).status,
	200,
);
const visible = await (await call(overviewPath, 'GET', undefined, memberCookie)).json();
assert.equal(visible.canManage, false);
assert.equal(visible.rows.length, 2);
assert.ok(!JSON.stringify(visible).includes('invented-openai-value'));
assert.equal(
	(
		await call(
			base + '/sharing',
			'PUT',
			{kind: 'person', id: owner.id, scope: ['OPENAI_API_KEY'], names: ['OPENAI_API_KEY']},
			memberCookie,
		)
	).status,
	403,
);
const humanRead = await call(base + '/reveal', 'POST', {names: ['OPENAI_API_KEY']}, memberCookie);
assert.equal(humanRead.headers.get('cache-control'), 'no-store');
assert.deepEqual(await humanRead.json(), {variables: {OPENAI_API_KEY: 'invented-openai-value'}});
assert.equal(
	(await call(base + '/reveal', 'POST', {names: ['OPENAI_API_KEY', 'PUBLIC']}, memberCookie))
		.status,
	403,
);
assert.equal(
	(
		await call(base + '/sharing', 'PUT', {
			kind: 'person',
			id: member.id,
			scope: ['OPENAI_API_KEY'],
			names: [],
		})
	).status,
	200,
);
assert.equal(
	(await call(base + '/reveal', 'POST', {names: ['OPENAI_API_KEY']}, memberCookie)).status,
	403,
);
assert.equal(
	(await call(base + '/reveal', 'POST', {names: ['STRIPE_SECRET_KEY']}, memberCookie)).status,
	200,
);
// More than the 100-row history limit, plus an older retrieval excluded from the count.
await db.environmentAccess.createMany({
	data: Array.from({length: 120}, () => ({
		orgId: org.id,
		project: 'example',
		agentId: agent.id,
		names: ['OPENAI_API_KEY'],
		allowed: true,
	})),
});
await db.environmentAccess.create({
	data: {
		orgId: org.id,
		project: 'example',
		agentId: agent.id,
		names: ['OPENAI_API_KEY'],
		allowed: true,
		createdAt: new Date(Date.now() - 31 * 86400000),
	},
});
const overview = await (await call(overviewPath)).json();
assert.equal(
	overview.rows.find((r: {service: string}) => r.service === 'OpenAI').accesses30Days,
	121,
);
const history = await (await call(base + '/history', 'POST', {names: ['OPENAI_API_KEY']})).json();
assert.equal(history.access.length, 100);
assert.ok(!JSON.stringify(history).includes('invented-openai-value'));
assert.equal(
	(await call(base + '/history', 'POST', {names: ['OPENAI_API_KEY']}, memberCookie)).status,
	403,
);
// Deletion prunes permissions; re-adding a key must not resurrect a grant.
assert.equal((await call(base + '/keys/STRIPE_SECRET_KEY', 'DELETE')).status, 200);
assert.equal(
	(
		await call(base + '/keys', 'PUT', {
			name: 'STRIPE_SECRET_KEY',
			value: 'replacement',
			service: 'Stripe',
			label: 'Secret key',
		})
	).status,
	200,
);
assert.equal(
	(await call(base + '/reveal', 'POST', {names: ['STRIPE_SECRET_KEY']}, memberCookie)).status,
	403,
);
assert.equal(
	(
		await call(base + '/sharing', 'PUT', {
			kind: 'person',
			id: member.id,
			scope: ['STRIPE_SECRET_KEY'],
			names: ['STRIPE_SECRET_KEY'],
		})
	).status,
	200,
);
await db.orgMember.delete({where: {orgId_userId: {orgId: org.id, userId: member.id}}});
assert.equal(await db.developmentEnvironmentPersonGrant.count(), 0);
assert.notEqual(
	(await call(base + '/reveal', 'POST', {names: ['STRIPE_SECRET_KEY']}, memberCookie)).status,
	200,
);
console.log(
	'Human sharing, masked metadata, read audit, exact 30-day counts, key deletion and membership revocation passed',
);
await db.organization.delete({where: {id: org.id}});
assert.equal(await db.developmentEnvironment.count(), 0);
assert.equal(await db.environmentAccess.count(), 0);
console.log(
	'HTTP authentication, encryption, explicit grants, variable removal, revocation and cascades passed',
);
app.close();
await db.$disconnect();
await server.close();
