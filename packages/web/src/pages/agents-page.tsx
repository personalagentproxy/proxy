import {PlusIcon} from 'lucide-react';
import {useState} from 'react';
import {useLoaderData, useNavigate} from 'react-router';
import {
	AGENT_PROVIDERS,
	findAgentProvider,
	type AgentProvider,
	type AgentProviderId,
} from '@proxy/integrations';
import {createAgent} from '@/client/agents-client';
import {AgentLogo} from '@/components/brand-logo';
import {AppShell, PageTitle} from '@/components/app-shell';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {formatAgo} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import {cn} from '@proxy/ui/lib/utils';
import type {agentsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	company: 'hidden w-24 shrink-0 truncate text-muted-foreground md:block',
	username: 'hidden w-52 shrink-0 truncate font-mono text-muted-foreground md:block',
	active: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// Every agent login, newest first. A revoked one stays listed, muted, until it is deleted.
export function AgentsPage() {
	const {agents} = useLoaderData<typeof agentsLoader>();
	const [creating, setCreating] = useState(false);
	const active = agents.filter((agent) => agent.revokedAt === null).length;
	const availableProviders = AGENT_PROVIDERS.filter(
		(provider) => !agents.some((agent) => agent.providerId === provider.id),
	);

	return (
		<AppShell
			title={<PageTitle detail={`${active} active`}>Agents</PageTitle>}
			actions={
				<Button
					size="sm"
					disabled={availableProviders.length === 0}
					onClick={() => setCreating(true)}
				>
					<PlusIcon data-icon="inline-start" />
					{availableProviders.length === 0 ? 'All agents added' : 'New agent'}
				</Button>
			}
		>
			<RowList
				header={
					<RowHeader>
						<span className="size-5 shrink-0" />
						<span className="min-w-0 flex-1">Agent</span>
						<span className={CELLS.company}>Company</span>
						<span className={CELLS.username}>Username</span>
						<span className={CELLS.active}>Last active</span>
					</RowHeader>
				}
			>
				{agents.length === 0 && <EmptyRows>No agents yet.</EmptyRows>}
				{agents.map((agent) => {
					const revoked = agent.revokedAt !== null;
					return (
						<Row
							key={agent.id}
							to={`/agents/${agent.id}`}
							icon={<AgentLogo providerId={agent.providerId} />}
							title={
								<span className={cn(revoked && 'text-muted-foreground')}>
									{agent.name}
									{revoked && ' · Revoked'}
								</span>
							}
							cells={
								<>
									<span className={CELLS.company}>
										{findAgentProvider(agent.providerId)?.company ?? agent.providerId}
									</span>
									<span className={CELLS.username}>{agent.username}</span>
									<span className={CELLS.active}>
										{agent.lastActiveAt ? formatAgo(agent.lastActiveAt) : 'Never'}
									</span>
								</>
							}
						/>
					);
				})}
			</RowList>
			<NewAgentDialog
				open={creating}
				providers={availableProviders}
				onClose={() => setCreating(false)}
			/>
		</AppShell>
	);
}

// A company gets one login. The generated password is shown once on the new agent's page.
function NewAgentDialog({
	open,
	providers,
	onClose,
}: {
	open: boolean;
	providers: AgentProvider[];
	onClose: () => void;
}) {
	const navigate = useNavigate();
	const [providerId, setProviderId] = useState<AgentProviderId | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const close = () => {
		setProviderId(null);
		setError(null);
		onClose();
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				close();
			}}
		>
			<DialogContent>
				<form
					className="grid gap-4"
					onSubmit={async (event) => {
						event.preventDefault();
						if (providerId === null) {
							return;
						}

						setPending(true);
						const result = await createAgent(providerId);
						setPending(false);
						if (result.isErr()) {
							setError(describeFetchError(result.error));
							return;
						}
						close();
						navigate(`/agents/${result.value.agent.id}`, {
							state: {password: result.value.password},
						});
					}}
				>
					<DialogHeader>
						<DialogTitle>New agent</DialogTitle>
						<DialogDescription>
							Choose an agent. It starts with each connection's default access; you can change it
							next.
						</DialogDescription>
					</DialogHeader>
					<fieldset>
						<legend className="mb-2 text-sm leading-none font-medium">Agent</legend>
						<div className="grid gap-2 sm:grid-cols-2">
							{providers.map((provider, index) => (
								<button
									key={provider.id}
									type="button"
									autoFocus={index === 0}
									aria-pressed={providerId === provider.id}
									className={cn(
										'flex items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/50',
										providerId === provider.id && 'border-foreground bg-muted/50',
									)}
									onClick={() => setProviderId(provider.id)}
								>
									<AgentLogo providerId={provider.id} />
									<span className="min-w-0">
										<span className="block truncate text-sm font-medium">{provider.name}</span>
										<span className="block truncate text-xs text-muted-foreground">
											{provider.company}
										</span>
									</span>
								</button>
							))}
						</div>
					</fieldset>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" disabled={providerId === null || pending}>
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
