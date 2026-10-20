import {useId, useState} from 'react';
import {useLoaderData, useLocation, useNavigate, useRevalidator} from 'react-router';
import {type AgentTask, finishAgentTask, startAgentTask} from '@/client/agent-client';
import {AgentHeading, AgentShell} from '@/components/agent-shell';
import {Row, RowList} from '@/components/row-list';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {Textarea} from '@proxy/ui/components/textarea';
import {agentErrorMessage} from '@/lib/agent-errors';
import {clearAgentTask, storeAgentTask, useStoredAgentTask} from '@/lib/agent-task';
import type {agentTasksLoader} from '@/agent-loaders';
import {noticeFromState} from '@/pages/agent/agent-collection-page';

// Where an agent starts, as the MCP server's start_task: what it is about to do for the person, as
// one task with a title and a goal. An agent can have any number of tasks under way at once: they
// are listed here, to work on or finish, and the pages make their requests for the one chosen.
export function AgentTaskPage() {
	const {tasks} = useLoaderData<typeof agentTasksLoader>();
	const navigate = useNavigate();
	const notice = noticeFromState(useLocation().state);
	const current = useStoredAgentTask();
	const [error, setError] = useState<string | null>(null);

	const workOn = (task: AgentTask) => {
		storeAgentTask({id: task.task, title: task.title, goal: task.goal});
		navigate('/agent');
	};

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
								<TaskRow
									key={task.task}
									task={task}
									current={task.task === current?.id}
									onWorkOn={() => workOn(task)}
									onError={setError}
								/>
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

// One task under way: the row works on it, the button beside it finishes it. Finishing the one the
// pages are on lets it go.
function TaskRow({
	task,
	current,
	onWorkOn,
	onError,
}: {
	task: AgentTask;
	current: boolean;
	onWorkOn: () => void;
	onError: (message: string | null) => void;
}) {
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
		if (current) {
			clearAgentTask();
		}
		await revalidate();
	};

	return (
		<Row
			onClick={onWorkOn}
			title={task.title}
			subtitle={task.goal}
			cells={
				<span className="shrink-0 text-muted-foreground">
					{current ? 'Working on it' : 'Work on this'}
				</span>
			}
			after={
				<Button size="sm" variant="outline" disabled={finishing} onClick={() => void finish()}>
					{finishing ? 'Finishing…' : 'Finish'}
				</Button>
			}
		/>
	);
}

// Starting a task: a title and a goal. The new task is the one the pages work on from here.
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
		storeAgentTask({id: result.value.task, title: result.value.title, goal: result.value.goal});
		navigate('/agent', {replace: true});
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
