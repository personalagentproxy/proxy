import {useId, useState} from 'react';
import {
	useLoaderData,
	useLocation,
	useNavigate,
	useRevalidator,
	useSearchParams,
} from 'react-router';
import {type AgentTask, finishAgentTask, startAgentTask} from '@/client/agent-client';
import {AgentHeading, AgentShell} from '@/components/agent-shell';
import {Row, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {Textarea} from '@proxy/ui/components/textarea';
import {agentErrorMessage} from '@/lib/agent-errors';
import {taskHome} from '@/lib/agent-task';
import type {agentTasksLoader} from '@/agent-loaders';
import {noticeFromState} from '@/pages/agent/agent-collection-page';

// Where an agent starts, as the MCP server's start_task: what it is about to do for the person, as
// one task with a title and a goal. An agent can have any number of tasks under way at once: they
// are listed here, each opening its own pages, `/agent/<task>`, which make their requests for it.
// An agent sent back here because its task was refused, `?refused=`, is told so.
export function AgentTaskPage() {
	const {tasks} = useLoaderData<typeof agentTasksLoader>();
	const [params] = useSearchParams();
	const refused = params.get('refused');
	const notice =
		noticeFromState(useLocation().state) ??
		(refused
			? `Task ${refused} can’t be worked on anymore: it is finished, was left open over a day, or isn’t this login’s. Carry on with another, or start one for what you are doing now`
			: null);
	const [error, setError] = useState<string | null>(null);

	return (
		<AgentShell>
			<div className="flex flex-col gap-8">
				{tasks.length > 0 && (
					<div className="flex flex-col gap-4">
						<AgentHeading detail={`${tasks.length} under way`}>Your tasks</AgentHeading>
						{notice && <p className="text-sm">{notice}.</p>}
						<p className="text-sm text-muted-foreground">
							Work on any of them: the pages then make their requests for it. Finish a task once you
							have done what the person asked for with it, or given it up.
						</p>
						<RowList>
							{tasks.map((task) => (
								<TaskRow key={task.task} task={task} onError={setError} />
							))}
						</RowList>
						{error && <p className="text-sm text-destructive">{error}</p>}
					</div>
				)}
				<StartTaskForm first={tasks.length === 0} notice={tasks.length === 0 ? notice : null} />
			</div>
		</AgentShell>
	);
}

// One task under way: the row opens its pages, the button beside it finishes it.
function TaskRow({task, onError}: {task: AgentTask; onError: (message: string | null) => void}) {
	const {revalidate} = useRevalidator();
	const [finishing, setFinishing] = useState(false);

	const finish = async () => {
		setFinishing(true);
		onError(null);
		const result = await finishAgentTask(task.task);
		setFinishing(false);
		if (result.isErr()) {
			onError(agentErrorMessage(result.error));
			return;
		}
		await revalidate();
	};

	return (
		<Row
			to={taskHome(task.task)}
			title={task.title}
			subtitle={task.goal}
			cells={<span className="shrink-0 text-muted-foreground">Work on this</span>}
			after={
				<Button size="sm" variant="outline" disabled={finishing} onClick={() => void finish()}>
					{finishing ? 'Finishing…' : 'Finish'}
				</Button>
			}
		/>
	);
}

// Starting a task: a title and a goal. The new task's pages open on it.
function StartTaskForm({first, notice}: {first: boolean; notice: string | null}) {
	const id = useId();
	const navigate = useNavigate();
	const [title, setTitle] = useState('');
	const [goal, setGoal] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [starting, setStarting] = useState(false);

	const start = async () => {
		setStarting(true);
		setError(null);
		const result = await startAgentTask({title, goal});
		setStarting(false);
		if (result.isErr()) {
			setError(agentErrorMessage(result.error));
			return;
		}
		navigate(taskHome(result.value.task));
	};

	return (
		<div className="flex flex-col gap-4">
			<AgentHeading>{first ? 'Start a task' : 'Start another task'}</AgentHeading>
			{notice && <p className="text-sm">{notice}.</p>}
			<div className="flex flex-col gap-4">
				<p className="text-sm text-muted-foreground">
					{first
						? 'Before anything else, say what you are about to do for the person here, as one task: '
						: 'Say what you are about to do for the person, as one task: '}
					a title in a few words, and the goal, what the person asked for, in a sentence or two.
					Every request you make is logged for the person with the task it was for. You can have as
					many tasks under way as you like, one for each thing the person asks for; finish each when
					you are done with it.
				</p>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void start();
					}}
				>
					<div className="grid gap-2">
						<Label htmlFor={`${id}-title`}>Title</Label>
						<Input
							id={`${id}-title`}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							placeholder="Triage this morning’s inbox"
						/>
					</div>
					<div className="grid gap-2">
						<Label htmlFor={`${id}-goal`}>Goal</Label>
						<Textarea
							id={`${id}-goal`}
							rows={3}
							value={goal}
							onChange={(event) => setGoal(event.target.value)}
							placeholder="What the person asked for, in a sentence or two. Leave out their private information beyond what the task needs."
						/>
					</div>
					{error && <p className="text-sm text-destructive">{error}</p>}
					<div className="flex justify-end">
						<Button type="submit" disabled={starting || title.trim() === '' || goal.trim() === ''}>
							{starting ? 'Starting…' : 'Start task'}
						</Button>
					</div>
				</form>
			</div>
		</div>
	);
}
