import {z} from 'zod';
import {Err, Ok, Result} from 'ts-results-es';
import {db} from '@proxy/db';
import {ApiErr, Do, parseSchema, type ApiError} from '@proxy/utils';
import {environmentOverviewSchema, environmentHistorySchema, environmentService, environmentKeyLabel, environmentKeySchema, environmentServiceSchema} from '@proxy/contracts/environments';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import {requireViewer, requireOwner} from '../utils/user-org';
import {encryptSecret, decryptSecret} from '../utils/secret-crypto';
import {variablesSchema} from './variables';

const failure = () => ApiErr.internalError(new Error('Environment operation failed'));
const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const keyBody = z.object({
	name: environmentKeySchema,
	value: z
		.string()
		.max(65536)
		.refine((v) => !v.includes('\0'))
		.optional(),
	service: environmentServiceSchema,
	label: z.string().trim().min(1).max(100),
});
const grantBody = z.object({kind: z.enum(['person', 'agent']), id: z.string().min(1), scope: z.array(environmentKeySchema).min(1).max(100), names: z.array(environmentKeySchema).max(100)});
const readBody = z.object({names: z.array(environmentKeySchema).min(1).max(100)});

export function environmentOverview(req: AuthenticatedRequest): Promise<Result<z.infer<typeof environmentOverviewSchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(req));
		const owner = viewer.role === 'owner';
		const members = $((await Result.wrapAsync(() => db.orgMember.findMany({where: {orgId: viewer.orgId}, include: {user: true}}))).mapErr(failure));
		const member = members.find((m) => m.userId === viewer.userId);
		if (!member) {
			return $(Err(ApiErr.forbidden()));
		}
		const environments = $(
			(
				await Result.wrapAsync(() =>
					db.developmentEnvironment.findMany({where: {orgId: viewer.orgId}, include: {keys: true, grants: true, people: {include: {member: true}}}, orderBy: {project: 'asc'}}),
				)
			).mapErr(failure),
		);
		const organization = $((await Result.wrapAsync(() => db.organization.findUniqueOrThrow({where: {id: viewer.orgId}, select: {ownerUserId: true}}))).mapErr(failure));
		// Aggregate the whole window in the database, independently of the paged history.
		const stats = $(
			(
				await Result.wrapAsync(() =>
					db.environmentAccess.groupBy({by: ['project', 'names'], where: {orgId: viewer.orgId, allowed: true, method: {in: ['runtime', 'reveal']}}, _max: {createdAt: true}}),
				)
			).mapErr(failure),
		);
		const counts = $(
			(
				await Result.wrapAsync(() =>
					db.environmentAccess.groupBy({
						by: ['project', 'names'],
						where: {orgId: viewer.orgId, allowed: true, method: {in: ['runtime', 'reveal']}, createdAt: {gte: new Date(Date.now() - 30 * 86400000)}},
						_count: {_all: true},
					}),
				)
			).mapErr(failure),
		);
		const rows = environments.flatMap((env) => {
			const allowed = owner ? env.names : (env.people.find((p) => p.memberId === member.id)?.names ?? []);
			const keys = env.names
				.filter((name) => allowed.includes(name))
				.map((name) => ({name, label: env.keys.find((k) => k.name === name)?.label ?? environmentKeyLabel(name), service: env.keys.find((k) => k.name === name)?.service ?? environmentService(name)}));
			return [...new Set(keys.map((k) => k.service))].map((service) => {
				const grouped = keys.filter((k) => k.service === service);
				const names = grouped.map((k) => k.name);
				const matches = (row: {project: string; names: string[]}) => row.project === env.project && row.names.some((n) => names.includes(n));
				const dates = stats
					.filter(matches)
					.flatMap((s) => (s._max.createdAt ? [s._max.createdAt.toISOString()] : []))
					.sort();
				const people = env.people.filter((p) => p.names.some((n) => names.includes(n))).map((p) => p.member.userId);
				return {
					project: env.project,
					service,
					keys: grouped.map(({name, label}) => ({name, label})),
					people: [organization.ownerUserId, ...people],
					grants: owner
						? [
								...env.people.map((p) => ({kind: 'person' as const, id: p.member.userId, names: p.names.filter((n) => names.includes(n))})),
								...env.grants.map((g) => ({kind: 'agent' as const, id: g.agentId, names: g.names.filter((n) => names.includes(n))})),
							]
						: [],
					lastAccess: dates.at(-1) ?? null,
					accesses30Days: counts.filter(matches).reduce((sum, s) => sum + s._count._all, 0),
				};
			});
		});
		return {canManage: owner, people: members.map((m) => ({userId: m.userId, name: m.user.name, email: m.user.email, image: m.user.image, owner: m.userId === organization.ownerUserId})), rows};
	});
}

export function saveEnvironmentKey(req: AuthenticatedRequest): Promise<Result<{ok: boolean}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		const body = $(parseSchema(keyBody, req.body));
		const savedResult = $(
			(
				await Result.wrapAsync(() =>
					db.$transaction(
						async (tx) => {
							const env = await tx.developmentEnvironment.findUnique({where: {orgId_project: {orgId: viewer.orgId, project}}});
							const result = Do<{ciphertext: string; names: string[]}, ApiError>(($): {ciphertext: string; names: string[]} => {
								const plaintext = env ? $(decryptSecret(env.ciphertext)) : '{}';
								const variables = $(parseSchema(variablesSchema, $(Result.wrap(() => JSON.parse(plaintext)).mapErr(failure))));
								if (body.value === undefined && !Object.hasOwn(variables, body.name)) {
									return $(Err(ApiErr.validationError('A value is required for a new key')));
								}
								const next = body.value !== undefined ? {...variables, [body.name]: body.value} : variables;
								const valid = $(parseSchema(variablesSchema, next));
								return {ciphertext: $(encryptSecret(JSON.stringify(valid))), names: Object.keys(valid)};
							});
							if (result.isErr()) {
								return result;
							}
							const saved = await tx.developmentEnvironment.upsert({
								where: {orgId_project: {orgId: viewer.orgId, project}},
								create: {orgId: viewer.orgId, project, ...result.value},
								update: result.value,
							});
							await tx.developmentEnvironmentKey.upsert({
								where: {environmentId_name: {environmentId: saved.id, name: body.name}},
								create: {environmentId: saved.id, name: body.name, service: body.service, label: body.label},
								update: {service: body.service, label: body.label},
							});
							await tx.environmentAccess.create({data: {orgId: viewer.orgId, project, agentId: '', userId: viewer.userId, names: [body.name], allowed: true, method: 'edit'}});
							return Ok({ok: true});
						},
						{isolationLevel: 'Serializable'},
					),
				)
			).mapErr(failure),
		);
		return $(savedResult);
	});
}

export function shareEnvironmentKeys(req: AuthenticatedRequest): Promise<Result<{ok: boolean}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		const body = $(parseSchema(grantBody, req.body));
		const saved = $(
			(
				await Result.wrapAsync(() =>
					db.$transaction(
						async (tx) => {
							const env = await tx.developmentEnvironment.findUnique({where: {orgId_project: {orgId: viewer.orgId, project}}});
							if (!env || body.scope.some((n) => !env.names.includes(n)) || body.names.some((n) => !body.scope.includes(n))) {
								return false;
							}
							if (body.kind === 'person') {
								const member = await tx.orgMember.findUnique({where: {orgId_userId: {orgId: viewer.orgId, userId: body.id}}});
								if (!member) {
									return false;
								}
								const where = {environmentId_memberId: {environmentId: env.id, memberId: member.id}};
								const previous = await tx.developmentEnvironmentPersonGrant.findUnique({where});
								const names = [...new Set([...(previous?.names ?? []).filter((n) => !body.scope.includes(n)), ...body.names])];
								await tx.developmentEnvironmentPersonGrant.upsert({where, create: {environmentId: env.id, memberId: member.id, names}, update: {names}});
							}
							if (body.kind === 'agent') {
								const agent = await tx.agent.findFirst({where: {id: body.id, orgId: viewer.orgId, revokedAt: null}});
								if (!agent) {
									return false;
								}
								const where = {environmentId_agentId: {environmentId: env.id, agentId: agent.id}};
								const previous = await tx.developmentEnvironmentGrant.findUnique({where});
								const names = [...new Set([...(previous?.names ?? []).filter((n) => !body.scope.includes(n)), ...body.names])];
								await tx.developmentEnvironmentGrant.upsert({where, create: {environmentId: env.id, agentId: agent.id, names}, update: {names}});
							}
							await tx.environmentAccess.create({data: {orgId: viewer.orgId, project, agentId: '', userId: viewer.userId, names: body.scope, allowed: true, method: 'share'}});
							return true;
						},
						{isolationLevel: 'Serializable'},
					),
				)
			).mapErr(failure),
		);
		if (!saved) {
			return $(Err(ApiErr.forbidden()));
		}
		return {ok: true};
	});
}

export function revealEnvironmentKeys(req: AuthenticatedRequest): Promise<Result<{variables: Record<string, string>}, ApiError>> {
	return Do(async ($) => {
		req.res?.setHeader('Cache-Control', 'no-store');
		const viewer = $(await requireViewer(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		const body = $(parseSchema(readBody, req.body));
		const result = $(
			(
				await Result.wrapAsync(() =>
					db.$transaction(
						async (tx) => {
							const env = await tx.developmentEnvironment.findUnique({where: {orgId_project: {orgId: viewer.orgId, project}}, include: {people: {include: {member: true}}}});
							const permitted = viewer.role === 'owner' ? (env?.names ?? []) : (env?.people.find((p) => p.member.userId === viewer.userId && p.member.orgId === viewer.orgId)?.names ?? []);
							const allowed = !!env && body.names.every((n) => env.names.includes(n) && permitted.includes(n));
							if (!env || !allowed) {
								await tx.environmentAccess.create({data: {orgId: viewer.orgId, project, agentId: '', userId: viewer.userId, names: body.names, allowed: false, method: 'reveal'}});
								return Err(ApiErr.forbidden());
							}
							const revealed = Do<{variables: Record<string, string>}, ApiError>(($): {variables: Record<string, string>} => {
								const plaintext = $(decryptSecret(env.ciphertext));
								const variables = $(parseSchema(variablesSchema, $(Result.wrap(() => JSON.parse(plaintext)).mapErr(failure))));
								return {variables: Object.fromEntries(body.names.map((n) => [n, variables[n] ?? '']))};
							});
							if (revealed.isErr()) {
								return revealed;
							}
							await tx.environmentAccess.create({data: {orgId: viewer.orgId, project, agentId: '', userId: viewer.userId, names: body.names, allowed: true, method: 'reveal'}});
							return revealed;
						},
						{isolationLevel: 'Serializable'},
					),
				)
			).mapErr(failure),
		);
		return $(result);
	});
}

export function environmentHistory(req: AuthenticatedRequest): Promise<Result<z.infer<typeof environmentHistorySchema>, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireViewer(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		const body = $(parseSchema(readBody, req.body));
		const env = $(
			(await Result.wrapAsync(() => db.developmentEnvironment.findUnique({where: {orgId_project: {orgId: viewer.orgId, project}}, include: {people: {include: {member: true}}}}))).mapErr(failure),
		);
		const permitted = viewer.role === 'owner' ? (env?.names ?? []) : (env?.people.find((p) => p.member.userId === viewer.userId)?.names ?? []);
		if (!env || body.names.some((n) => !permitted.includes(n))) {
			return $(Err(ApiErr.forbidden()));
		}
		const rows = $(
			(
				await Result.wrapAsync(() => db.environmentAccess.findMany({where: {orgId: viewer.orgId, project, names: {hasSome: body.names}}, orderBy: [{createdAt: 'desc'}, {id: 'desc'}], take: 100}))
			).mapErr(failure),
		);
		const users = $((await Result.wrapAsync(() => db.user.findMany({where: {orgMembers: {some: {orgId: viewer.orgId}}}, select: {id: true, name: true, email: true}}))).mapErr(failure));
		const agents = $((await Result.wrapAsync(() => db.agent.findMany({where: {orgId: viewer.orgId}, select: {id: true, name: true}}))).mapErr(failure));
		return {
			access: rows.map((row) => ({
				id: row.id,
				actor: row.userId
					? (users.find((u) => u.id === row.userId)?.name ?? users.find((u) => u.id === row.userId)?.email ?? 'Former member')
					: (agents.find((a) => a.id === row.agentId)?.name ?? 'Former agent'),
				method: row.method,
				names: row.names.filter((n) => body.names.includes(n)),
				allowed: row.allowed,
				createdAt: row.createdAt.toISOString(),
			})),
		};
	});
}

export function deleteEnvironmentKey(req: AuthenticatedRequest): Promise<Result<{ok: boolean}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		const name = $(parseSchema(environmentKeySchema, req.params.name));
		const result = $(
			(
				await Result.wrapAsync(() =>
					db.$transaction(
						async (tx) => {
							const env = await tx.developmentEnvironment.findUnique({where: {orgId_project: {orgId: viewer.orgId, project}}, include: {people: true, grants: true}});
							if (!env) {
								return Err(ApiErr.forbidden());
							}
							const changed = Do<{ciphertext: string; names: string[]}, ApiError>(($): {ciphertext: string; names: string[]} => {
								const plaintext = $(decryptSecret(env.ciphertext));
								const variables = $(parseSchema(variablesSchema, $(Result.wrap(() => JSON.parse(plaintext)).mapErr(failure))));
								delete variables[name];
								return {ciphertext: $(encryptSecret(JSON.stringify(variables))), names: Object.keys(variables)};
							});
							if (changed.isErr()) {
								return changed;
							}
							await tx.developmentEnvironment.update({where: {id: env.id}, data: changed.value});
							await tx.developmentEnvironmentKey.deleteMany({where: {environmentId: env.id, name}});
							for (const person of env.people) {
								await tx.developmentEnvironmentPersonGrant.update({
									where: {environmentId_memberId: {environmentId: env.id, memberId: person.memberId}},
									data: {names: person.names.filter((n) => n !== name)},
								});
							}
							for (const agent of env.grants) {
								await tx.developmentEnvironmentGrant.update({where: {environmentId_agentId: {environmentId: env.id, agentId: agent.agentId}}, data: {names: agent.names.filter((n) => n !== name)}});
							}
							await tx.environmentAccess.create({data: {orgId: viewer.orgId, project, agentId: '', userId: viewer.userId, names: [name], allowed: true, method: 'delete'}});
							return Ok({ok: true});
						},
						{isolationLevel: 'Serializable'},
					),
				)
			).mapErr(failure),
		);
		return $(result);
	});
}
