import {BotIcon, PlusIcon} from 'lucide-react';
import {useState} from 'react';
import {useNavigate} from 'react-router';
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
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {formatAgo} from '@/lib/format';
import {cn} from '@/lib/utils';

// Widths and visibility shared by the header and every row, so the columns line up.
const CELLS = {
	username: 'hidden w-52 shrink-0 truncate font-mono text-xs text-muted-foreground md:block',
	active: 'w-24 shrink-0 text-right text-muted-foreground tabular-nums',
};

// Every agent login, newest first. A revoked one stays listed, muted, until it is deleted.
export function AgentsPage() {
	const {state} = useStore();
	const [creating, setCreating] = useState(false);
	const active = state.agents.filter((agent) => agent.revokedAt === null).length;

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
				{state.agents.length === 0 && <EmptyRows>No agents yet.</EmptyRows>}
				{state.agents.map((agent) => {
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

// Names the login; the username and password are made for it, and the agent's page shows the
// password the one time it can be seen.
function NewAgentDialog({open, onClose}: {open: boolean; onClose: () => void}) {
	const navigate = useNavigate();
	const {createAgent} = useStore();
	const [name, setName] = useState('');
	const close = () => {
		setName('');
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
						const id = createAgent(name);
						close();
						navigate(`/agents/${id}`, {state: {reveal: true}});
					}}
				>
					<DialogHeader>
						<DialogTitle>New agent</DialogTitle>
						<DialogDescription>
							A login for one agent. It starts with no access; you choose what it can reach next.
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
					<DialogFooter>
						<Button type="button" variant="outline" onClick={close}>
							Cancel
						</Button>
						<Button type="submit" disabled={name.trim().length === 0}>
							Create
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
