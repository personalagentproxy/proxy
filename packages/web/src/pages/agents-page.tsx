import {PlusIcon} from 'lucide-react';
import {useState} from 'react';
import {useNavigate} from 'react-router';
import {AgentFavicon} from '@/components/agent-favicon';
import {AppShell, PageTitle} from '@/components/app-shell';
import {useStore} from '@/components/mock-store';
import {EmptyRows, Row, RowHeader, RowList} from '@/components/row-list';
import {Button} from '@/components/ui/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@/components/ui/dialog';
import {
	AGENT_PROVIDERS,
	agentProvider,
	type AgentProvider,
	type AgentProviderId,
} from '@/lib/agent-providers';
import {formatAgo} from '@/lib/format';
import {cn} from '@/lib/utils';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	company: 'hidden w-24 shrink-0 truncate text-muted-foreground md:block',
	username: 'hidden w-52 shrink-0 truncate font-mono text-xs text-muted-foreground md:block',
	active: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// Every agent login, newest first. A revoked one stays listed, muted, until it is deleted.
export function AgentsPage() {
	const {state} = useStore();
	const [creating, setCreating] = useState(false);
	const active = state.agents.filter((agent) => agent.revokedAt === null).length;
	const availableProviders = AGENT_PROVIDERS.filter(
		(provider) => !state.agents.some((agent) => agent.providerId === provider.id),
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
						<span className="size-4 shrink-0" />
						<span className="min-w-0 flex-1">Agent</span>
						<span className={CELLS.company}>Company</span>
						<span className={CELLS.username}>Username</span>
						<span className={CELLS.active}>Last active</span>
					</RowHeader>
				}
			>
				{state.agents.length === 0 && <EmptyRows>No agents yet.</EmptyRows>}
				{state.agents.map((agent) => {
					const provider = agentProvider(agent.providerId);
					const revoked = agent.revokedAt !== null;
					return (
						<Row
							key={agent.id}
							to={`/agents/${agent.id}`}
							icon={<AgentFavicon provider={provider} className="size-4" />}
							title={
								<span className={cn(revoked && 'text-muted-foreground')}>
									{provider.name}
									{revoked && ' · Revoked'}
								</span>
							}
							cells={
								<>
									<span className={CELLS.company}>{provider.company}</span>
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
	const {createAgent} = useStore();
	const [providerId, setProviderId] = useState<AgentProviderId | null>(null);
	const close = () => {
		setProviderId(null);
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
					onSubmit={(event) => {
						event.preventDefault();
						if (providerId === null) {
							return;
						}

						const created = createAgent(providerId);
						close();
						navigate(`/agents/${created.id}`, {state: {reveal: created.created}});
					}}
				>
					<DialogHeader>
						<DialogTitle>New agent</DialogTitle>
						<DialogDescription>
							Choose an agent company. It starts with no access; you choose what it can reach next.
						</DialogDescription>
					</DialogHeader>
					<fieldset className="grid gap-2">
						<legend className="text-sm font-medium">Agent company</legend>
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
									<AgentFavicon provider={provider} />
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
					<DialogFooter>
						<Button type="button" variant="outline" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" disabled={providerId === null}>
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
