import {useHuman} from '@/hooks/use-human';
import {listAgents} from '@/client/agents-client';
import type {AgentLogin} from '@proxy/contracts/agents';
import {useCallback, useEffect, useState} from 'react';
import {z} from 'zod';
import {AppShell} from '@/components/app-shell';
import {useOrgSlug} from '@/hooks/use-org';
import {apiRequest, orgApi} from '@/client/request';
import {PillButton as Button} from '@proxy/ui/components/pill-button';

const bundleSchema = z.object({
	project: z.string(),
	names: z.array(z.string()),
	grants: z.array(z.object({agentId: z.string(), names: z.array(z.string())})),
});
const accessSchema = z.object({
	id: z.string(),
	project: z.string(),
	agentId: z.string(),
	names: z.array(z.string()),
	allowed: z.boolean(),
	createdAt: z.string(),
});
export function EnvironmentsPage() {
	const org = useOrgSlug();
	const human = useHuman();
	if (human?.org.role !== 'owner') {
		return (
			<AppShell title="Development environments">
				<p className="p-4">Only organization owners can manage development environments.</p>
			</AppShell>
		);
	}
	return <EnvironmentEditor key={org} org={org} />;
}
function EnvironmentEditor({org}: {org: string}) {
	const base = orgApi(org) + '/environments';
	const [agents, setAgents] = useState<AgentLogin[]>([]);
	const [bundles, setBundles] = useState<z.infer<typeof bundleSchema>[]>([]);
	const [access, setAccess] = useState<z.infer<typeof accessSchema>[]>([]);
	const [project, setProject] = useState('');
	const [values, setValues] = useState('');
	const [agentId, setAgentId] = useState('');
	const [names, setNames] = useState('');
	const [message, setMessage] = useState('');
	const [busy, setBusy] = useState(false);
	const refresh = useCallback(async () => {
		const result = await apiRequest(
			'GET',
			base + '/development',
			z.object({environments: z.array(bundleSchema)}),
		);
		if (result.isErr()) {
			setMessage('Unable to load environments. Organization owner access is required.');
			return;
		}
		setBundles(result.value.environments);
		const audit = await apiRequest(
			'GET',
			base + '/access',
			z.object({access: z.array(accessSchema)}),
		);
		if (audit.isErr()) {
			setMessage('Unable to load access history.');
			return;
		}
		setAccess(audit.value.access);
		const available = await listAgents(org);
		if (available.isOk()) {
			setAgents(available.value.agents.filter((agent) => agent.revokedAt === null));
		}
	}, [base, org]);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	async function save() {
		const parsed = z
			.string()
			.transform((text, ctx) => {
				try {
					return JSON.parse(text);
				} catch {
					ctx.addIssue({code: 'custom', message: 'Invalid JSON'});
					return z.NEVER;
				}
			})
			.pipe(z.record(z.string(), z.string()))
			.safeParse(values);
		if (!parsed.success) {
			setMessage('Enter a JSON object containing variable names and string values.');
			return;
		}
		if (
			bundles.some((bundle) => bundle.project === project) &&
			!window.confirm(
				'Replace all variables for ' +
					project +
					'? Omitted variables and their grants will be removed.',
			)
		) {
			return;
		}
		setBusy(true);
		const result = await apiRequest(
			'PUT',
			base + '/development/' + encodeURIComponent(project),
			z.object({project: z.string(), names: z.array(z.string())}),
			parsed.data,
		);
		setBusy(false);
		if (result.isErr()) {
			setMessage('Could not save environment. Check the project and variable names.');
			return;
		}
		setValues('');
		setMessage('Environment saved.');
		await refresh();
	}
	async function grant() {
		setBusy(true);
		const result = await apiRequest(
			'PUT',
			base + '/development/' + encodeURIComponent(project) + '/grants',
			z.object({ok: z.boolean()}),
			{
				agentId,
				names: names
					.split(',')
					.map((name) => name.trim())
					.filter(Boolean),
			},
		);
		setBusy(false);
		if (result.isErr()) {
			setMessage('Could not update access. Check the agent ID and variable names.');
			return;
		}
		setMessage('Access updated.');
		await refresh();
	}
	async function remove(selected: string) {
		if (
			!window.confirm('Delete development environment ' + selected + ' and revoke all its grants?')
		) {
			return;
		}
		setBusy(true);
		const result = await apiRequest(
			'DELETE',
			base + '/development/' + encodeURIComponent(selected),
			z.object({ok: z.boolean()}),
		);
		setBusy(false);
		if (result.isErr()) {
			setMessage('Could not delete environment.');
			return;
		}
		setMessage('Environment deleted.');
		await refresh();
	}
	const input = 'block w-full rounded border p-2 bg-background';
	return (
		<AppShell title="Development environments">
			<div className="max-w-3xl space-y-8 p-4">
				<p>
					Store development configuration and explicitly grant agents access to selected variables.
					Only organization owners can manage environments.
				</p>
				<p role="status">{message}</p>
				<section className="space-y-3">
					<h2 className="font-semibold">Save an environment</h2>
					<label>
						Project
						<input
							className={input}
							value={project}
							onChange={(event) => setProject(event.target.value)}
							placeholder="example-project"
						/>
					</label>
					<label>
						Variables (JSON)
						<textarea
							className={input + ' min-h-40 font-mono'}
							value={values}
							onChange={(event) => setValues(event.target.value)}
							autoComplete="off"
							spellCheck={false}
							placeholder={'{"API_KEY": "value"}'}
						/>
					</label>
					<p>
						Saving replaces all variables for this project. Existing secret values are never
						displayed.
					</p>
					<Button disabled={busy || !project || !values} onClick={() => void save()}>
						Save environment
					</Button>
				</section>
				<section className="space-y-3">
					<h2 className="font-semibold">Grant agent access</h2>
					<p>Uses the project entered above. An empty variable list revokes access.</p>
					<label>
						Agent
						<select
							className={input}
							value={agentId}
							onChange={(event) => setAgentId(event.target.value)}
						>
							<option value="">Select an agent</option>
							{agents.map((agent) => (
								<option key={agent.id} value={agent.id}>
									{agent.name} ({agent.username})
								</option>
							))}
						</select>
					</label>
					<label>
						Allowed variable names, comma-separated
						<input
							className={input}
							value={names}
							onChange={(event) => setNames(event.target.value)}
						/>
					</label>
					<Button disabled={busy || !project || !agentId} onClick={() => void grant()}>
						Update access
					</Button>
				</section>
				<section className="space-y-3">
					<h2 className="font-semibold">Environments</h2>
					{bundles.length === 0 && <p>No environments yet.</p>}
					{bundles.map((bundle) => (
						<article className="rounded border p-4 space-y-2" key={bundle.project}>
							<h3>{bundle.project}</h3>
							<p>{bundle.names.join(', ') || 'No variables'}</p>
							{bundle.grants.map((item) => (
								<p key={item.agentId}>
									{agents.find((agent) => agent.id === item.agentId)?.name ?? item.agentId}:{' '}
									{item.names.join(', ') || 'Access revoked'}
								</p>
							))}
							<Button
								disabled={busy}
								onClick={() => {
									setProject(bundle.project);
									setValues('');
								}}
							>
								Select project
							</Button>{' '}
							<Button disabled={busy} onClick={() => void remove(bundle.project)}>
								Delete
							</Button>
						</article>
					))}
				</section>
				<section className="space-y-3">
					<h2 className="font-semibold">Recent runtime access</h2>
					<p>Most recent 100 attempts. Secret values are never recorded.</p>
					{access.map((row) => (
						<article className="border-b py-2" key={row.id}>
							<p>
								{row.project} · {row.allowed ? 'Allowed' : 'Denied'} ·{' '}
								{new Date(row.createdAt).toLocaleString()}
							</p>
							<p>
								{agents.find((agent) => agent.id === row.agentId)?.name ?? row.agentId} ·{' '}
								{row.names.join(', ')}
							</p>
						</article>
					))}
				</section>
			</div>
		</AppShell>
	);
}
