import {z} from 'zod';
import {Err, Result} from 'ts-results-es';
import {db} from '@proxy/db';
import {type ApiError, ApiErr, Do, parseSchema} from '@proxy/utils';
import type {AuthenticatedRequest} from '../server/middleware/require-auth';
import type {AgentRequest} from '../server/middleware/require-agent';
import {requireOwner} from '../utils/user-org';
import {encryptSecret, decryptSecret} from '../utils/secret-crypto';

import {variablesSchema} from './variables';

const projectSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const grantSchema = z.object({agentId: z.string().min(1), names: z.array(z.string()).max(100)});

export function saveEnvironment(req: AuthenticatedRequest): Promise<Result<{project: string; names: string[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		const variables = $(parseSchema(variablesSchema, req.body));
		const ciphertext = $(encryptSecret(JSON.stringify(variables)));
		$(
			(
				await Result.wrapAsync(() =>
					db.$transaction(
						async (tx) => {
							const environment = await tx.developmentEnvironment.upsert({
								where: {orgId_project: {orgId: viewer.orgId, project}},
								create: {orgId: viewer.orgId, project, ciphertext, names: Object.keys(variables)},
								update: {ciphertext, names: Object.keys(variables)},
							});
							const grants = await tx.developmentEnvironmentGrant.findMany({where: {environmentId: environment.id}});
							for (const grant of grants) {
								await tx.developmentEnvironmentGrant.update({
									where: {environmentId_agentId: {environmentId: environment.id, agentId: grant.agentId}},
									data: {names: grant.names.filter((name) => Object.hasOwn(variables, name))},
								});
							}
						},
						{isolationLevel: 'Serializable'},
					),
				)
			).mapErr(() => ApiErr.internalError(new Error('Environment operation failed'))),
		);
		return {project, names: Object.keys(variables)};
	});
}

export function grantEnvironment(req: AuthenticatedRequest): Promise<Result<{ok: boolean}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		const grant = $(parseSchema(grantSchema, req.body));
		const saved = $(
			(
				await Result.wrapAsync(async () => {
					return db.$transaction(
						async (tx) => {
							const environment = await tx.developmentEnvironment.findUnique({where: {orgId_project: {orgId: viewer.orgId, project}}});
							const agent = await tx.agent.findFirst({where: {id: grant.agentId, orgId: viewer.orgId, revokedAt: null}});
							if (!environment || !agent || grant.names.some((name) => !environment.names.includes(name))) {
								return false;
							}
							await tx.developmentEnvironmentGrant.upsert({
								where: {environmentId_agentId: {environmentId: environment.id, agentId: agent.id}},
								create: {environmentId: environment.id, ...grant},
								update: {names: grant.names},
							});
							return true;
						},
						{isolationLevel: 'Serializable'},
					);
				})
			).mapErr(() => ApiErr.internalError(new Error('Environment operation failed'))),
		);
		if (!saved) {
			return $(Err(ApiErr.forbidden()));
		}
		return {ok: true};
	});
}

export function readEnvironment(req: AgentRequest): Promise<Result<{variables: Record<string, string>}, ApiError>> {
	return Do(async ($) => {
		req.res?.setHeader('Cache-Control', 'no-store');
		const project = $(parseSchema(projectSchema, req.params.project));
		const environment = $(
			(
				await Result.wrapAsync(() => db.developmentEnvironment.findUnique({where: {orgId_project: {orgId: req.agent.orgId, project}}, include: {grants: {where: {agentId: req.agent.agentId}}}}))
			).mapErr(() => ApiErr.internalError(new Error('Environment operation failed'))),
		);
		const names = (environment?.grants[0]?.names ?? []).filter((name) => environment?.names.includes(name));
		const allowed = names.length > 0;
		$(
			(await Result.wrapAsync(() => db.environmentAccess.create({data: {orgId: req.agent.orgId, agentId: req.agent.agentId, project, names, allowed}}))).mapErr(() =>
				ApiErr.internalError(new Error('Environment operation failed')),
			),
		);
		if (!environment || !allowed) {
			return $(Err(ApiErr.forbidden()));
		}
		const plaintext = $(decryptSecret(environment.ciphertext));
		const parsed = $(Result.wrap(() => JSON.parse(plaintext)).mapErr(() => ApiErr.internalError(new Error('Environment operation failed'))));
		const variables = $(parseSchema(variablesSchema, parsed));
		return {variables: Object.fromEntries(Object.entries(variables).filter(([name]) => names.includes(name)))};
	});
}

export function listEnvironments(req: AuthenticatedRequest): Promise<Result<{environments: {project: string; names: string[]; grants: {agentId: string; names: string[]}[]}[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const environments = $(
			(
				await Result.wrapAsync(() =>
					db.developmentEnvironment.findMany({where: {orgId: viewer.orgId}, orderBy: {project: 'asc'}, select: {project: true, names: true, grants: {select: {agentId: true, names: true}}}}),
				)
			).mapErr(() => ApiErr.internalError(new Error('Environment operation failed'))),
		);
		return {environments};
	});
}

export function deleteEnvironment(req: AuthenticatedRequest): Promise<Result<{ok: boolean}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const project = $(parseSchema(projectSchema, req.params.project));
		$((await Result.wrapAsync(() => db.developmentEnvironment.deleteMany({where: {orgId: viewer.orgId, project}}))).mapErr(() => ApiErr.internalError(new Error('Environment operation failed'))));
		return {ok: true};
	});
}

export function listEnvironmentAccess(
	req: AuthenticatedRequest,
): Promise<Result<{access: {id: string; project: string; agentId: string; names: string[]; allowed: boolean; createdAt: string}[]}, ApiError>> {
	return Do(async ($) => {
		const viewer = $(await requireOwner(req));
		const rows = $(
			(await Result.wrapAsync(() => db.environmentAccess.findMany({where: {orgId: viewer.orgId}, orderBy: [{createdAt: 'desc'}, {id: 'desc'}], take: 100}))).mapErr(() =>
				ApiErr.internalError(new Error('Environment operation failed')),
			),
		);
		return {access: rows.map(({id, project, agentId, names, allowed, createdAt}) => ({id, project, agentId, names, allowed, createdAt: createdAt.toISOString()}))};
	});
}
