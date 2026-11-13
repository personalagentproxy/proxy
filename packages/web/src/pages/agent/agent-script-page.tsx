import type {ScriptRun} from '@proxy/contracts/agent-side';
import type {FetchError} from '@proxy/utils';
import {useId, useState} from 'react';
import {useLoaderData, useNavigate} from 'react-router';
import {runAgentScript, signOutAgent} from '@/client/agent-client';
import {AgentLogo} from '@/components/brand-logo';
import {useTitleBarHeader} from '@/hooks/use-title-bar-header';
import type {agentPageLoader} from '@/loaders';
import {apiMessage} from '@/lib/api-message';
import {PillButton} from '@proxy/ui/components/pill-button';
import {Label} from '@proxy/ui/components/label';
import {Textarea} from '@proxy/ui/components/textarea';
import {cn} from '@proxy/ui/lib/utils';

// The task the page sends with each script, kept for the tab, so a reload carries on with it.
const TASK_KEY = 'proxy.agent.task';

function failedRun(error: FetchError): string {
	if (error.kind === 'http' && error.status === 401) {
		return 'This login has been signed out. Sign in again.';
	}
	if (error.kind === 'http') {
		return apiMessage(error.body) ?? 'Something went wrong. Try again.';
	}
	return 'The request didn’t reach Personal Agent Proxy. Try again.';
}

// Personal Agent Proxy for an agent driving a browser: the MCP server's one tool, `script`, as a
// text field. The agent writes a script, sends it, and reads what it came to below, then what it
// is told, as an MCP client is when it connects. The page keeps the task a script started
// and sends it with the next, as an MCP client gives `task`, until a script finishes it.
export function AgentScriptPage() {
	const {agent, instructions} = useLoaderData<typeof agentPageLoader>();
	const navigate = useNavigate();
	const titleBarHeader = useTitleBarHeader();
	const id = useId();
	const [code, setCode] = useState('');
	const [running, setRunning] = useState(false);
	const [answer, setAnswer] = useState<Pick<ScriptRun, 'text' | 'isError'> | null>(null);

	const send = async () => {
		if (running || code.trim() === '') {
			return;
		}
		setRunning(true);
		const task = sessionStorage.getItem(TASK_KEY) ?? undefined;
		const result = await runAgentScript({code, task});
		setRunning(false);
		if (result.isErr()) {
			setAnswer({text: failedRun(result.error), isError: true});
			return;
		}
		const run = result.value;
		if (run.task === null) {
			sessionStorage.removeItem(TASK_KEY);
		}
		if (run.task !== null) {
			sessionStorage.setItem(TASK_KEY, run.task);
		}
		setAnswer({text: run.text, isError: run.isError});
	};

	return (
		<div data-page className="flex min-h-dvh w-full flex-col bg-background text-foreground">
			<header
				ref={titleBarHeader}
				className="sticky top-0 z-20 flex items-center justify-between gap-4 border-b bg-background pr-4"
			>
				<span className="shrink-0 text-sm font-medium whitespace-nowrap">
					Personal Agent Proxy <span className="font-normal text-muted-foreground">for agents</span>
				</span>
				<div className="flex min-w-0 items-center gap-3">
					{/* Desktop only: a phone's header has room for the brand and the button, not the name too. */}
					<span className="hidden min-w-0 items-center gap-2 text-sm text-muted-foreground md:flex">
						<AgentLogo providerId={agent.providerId} />
						<span className="truncate">Signed in as {agent.name}</span>
					</span>
					<PillButton
						variant="ghost"
						onClick={async () => {
							await signOutAgent();
							sessionStorage.removeItem(TASK_KEY);
							navigate('/agent/login');
						}}
					>
						Sign out
					</PillButton>
				</div>
			</header>
			<main className="page-column mx-auto flex w-full max-w-3xl flex-col gap-4 pt-6 pb-12">
				<form
					className="grid gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						void send();
					}}
				>
					<Label htmlFor={`${id}-script`}>Script</Label>
					<Textarea
						id={`${id}-script`}
						autoFocus
						rows={8}
						spellCheck={false}
						className="font-mono"
						value={code}
						onChange={(event) => setCode(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
								event.preventDefault();
								void send();
							}
						}}
						placeholder="return await pap.connections();"
					/>
					<div className="flex justify-end">
						<PillButton type="submit" disabled={running || code.trim() === ''}>
							{running ? 'Running…' : 'Send'}
						</PillButton>
					</div>
				</form>
				{answer && (
					<section className="grid gap-2">
						<h2 className="text-sm font-medium">Answer</h2>
						<pre
							className={cn(
								'overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-sm break-words whitespace-pre-wrap',
								answer.isError && 'text-destructive',
							)}
						>
							{answer.text}
						</pre>
					</section>
				)}
				<section className="grid gap-2 pt-4">
					<h2 className="text-sm font-medium">How to write a script</h2>
					<p className="text-sm whitespace-pre-wrap text-muted-foreground">{instructions}</p>
				</section>
			</main>
		</div>
	);
}
