import {INTEGRATIONS} from '@proxy/integrations';
import {z} from 'zod';

export const environmentKeySchema = z
	.string()
	.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
	.max(200);
export const environmentServiceSchema = z.string().trim().min(1).max(80);
// Match names only. Values never participate in vendor discovery.
const vendors = [
	'OpenAI',
	'Anthropic',
	'Clerk',
	'Stripe',
	'Vercel',
	'Cloudflare',
	'Supabase',
	'Resend',
	'Twilio',
	'PostHog',
	'Langfuse',
	'Google',
	'GitHub',
	'Linear',
	'Notion',
	'Attio',
	'Porter',
	'AWS',
	'Azure',
	'Sentry',
	'Redis',
	'Postgres',
];
export function environmentService(name: string): string {
	const normalized = name.replace(/^(NEXT_PUBLIC_|PUBLIC_|VITE_)/, '').toLowerCase();
	return (
		[...vendors, ...INTEGRATIONS.map((vendor) => vendor.name)].find((vendor) =>
			normalized.startsWith(vendor.toLowerCase().replace(/ /g, '_') + '_'),
		) ?? 'Other configuration'
	);
}
export function environmentKeyLabel(name: string): string {
	return name
		.replace(/^(NEXT_PUBLIC_|PUBLIC_|VITE_)/, '')
		.replace(/_/g, ' ')
		.toLowerCase()
		.replace(/^./, (letter) => letter.toUpperCase());
}
const personSchema = z.object({
	userId: z.string(),
	name: z.string().nullable(),
	email: z.string(),
	image: z.string().nullable(),
	owner: z.boolean(),
});
export const environmentOverviewSchema = z.object({
	canManage: z.boolean(),
	people: z.array(personSchema),
	rows: z.array(
		z.object({
			project: z.string(),
			service: z.string(),
			keys: z.array(z.object({name: z.string(), label: z.string()})),
			people: z.array(z.string()),
			grants: z.array(
				z.object({kind: z.enum(['person', 'agent']), id: z.string(), names: z.array(z.string())}),
			),
			lastAccess: z.string().nullable(),
			accesses30Days: z.number(),
		}),
	),
});
export type EnvironmentRow = z.infer<typeof environmentOverviewSchema>['rows'][number];
export const environmentHistorySchema = z.object({
	access: z.array(
		z.object({
			id: z.string(),
			actor: z.string(),
			method: z.string(),
			names: z.array(z.string()),
			allowed: z.boolean(),
			createdAt: z.string(),
		}),
	),
});
