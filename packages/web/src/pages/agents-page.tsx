import {BotIcon, PlusIcon} from 'lucide-react';
import {useState} from 'react';
import {useLoaderData, useNavigate} from 'react-router';
import {createAgent} from '@/client/agents-client';
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
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {formatAgo} from '@/lib/format';
import {describeFetchError} from '@/lib/loader-utils';
import {cn} from '@proxy/ui/lib/utils';
import type {agentsLoader} from '@/loaders';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	username: 'hidden w-52 shrink-0 truncate font-mono text-xs text-muted-foreground md:block',
	active: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// Every agent login, newest first. A revoked one stays listed, muted, until it is deleted.
export function AgentsPage() {
	const {agents} = useLoaderData<typeof agentsLoader>();
	const [creating, setCreating] = useState(false);
	const active = agents.filter((agent) => agent.revokedAt === null).length;

	return (
		<AppShell
			title={<PageTitle detail={`${active} active`}>Agents</PageTitle>}
			actions={
				<Button size="sm" onClick={() => setCreating(true)}>
					<PlusIcon data-icon="inline-start" />
					New agent
				</Button>
			}
		>
			<RowList
				header={
					<RowHeader>
						<span className="size-4 shrink-0" />
						<span className="min-w-0 flex-1">Name</span>
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
							icon={<BotIcon className="size-4 shrink-0 text-muted-foreground" />}
							title={
								<span className={cn(revoked && 'text-muted-foreground')}>
									{agent.name}
									{revoked && ' · Revoked'}
								</span>
							}
							cells={
								<>
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
			<NewAgentDialog open={creating} onClose={() => setCreating(false)} />
		</AppShell>
	);
}

// Names the login; the api makes its username and password, and the agent's page shows the
// password the one time it is sent.
function NewAgentDialog({open, onClose}: {open: boolean; onClose: () => void}) {
	const navigate = useNavigate();
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const close = () => {
		setName('');
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
						setPending(true);
						const result = await createAgent(name);
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
							A login for one agent. It starts with each connection's default access; you can change
							it next.
						</DialogDescription>
					</DialogHeader>
					<div className="grid gap-2">
						<Label htmlFor="agent-name">Name</Label>
						<Input
							id="agent-name"
							placeholder="Shopping agent"
							autoFocus
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						<Button type="button" variant="outline" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" disabled={name.trim().length === 0 || pending}>
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
