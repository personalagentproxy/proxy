import type {ChatPersona} from '@proxy/contracts/harness';
import {ArrowUpIcon} from 'lucide-react';
import {useRef, useState} from 'react';
import {postMessage} from '@/client/harness-client';
import {Head} from '@/components/head';
import {Button} from '@proxy/ui/components/button';
import {Select, SelectContent, SelectItem, SelectTrigger} from '@proxy/ui/components/select';
import {type BarAction, useBarAction} from '@/hooks/use-bar-action';
import {useOrgSlug} from '@/hooks/use-org';
import {useWriteStatus} from '@/hooks/use-write-status';
import {writeErrorMessage} from '@/lib/write-status';

// The agent a message goes to, in the line that says so, as the model is named under Chat's
// message box: its head and its name, which open the agents to pick another from where there is
// more than one.
function AgentPicker({
	personas,
	persona,
	onPick,
}: {
	personas: ChatPersona[];
	persona: ChatPersona;
	onPick: (id: string) => void;
}) {
	const shown = (
		<>
			<Head look={persona.look} color={persona.color} size={16} className="shrink-0" />
			<span className="truncate text-foreground">{persona.name}</span>
		</>
	);
	if (personas.length < 2) {
		return <span className="flex min-w-0 items-center gap-1.5">{shown}</span>;
	}

	return (
		<Select
			value={persona.id}
			onValueChange={(next) => {
				if (next !== null) {
					onPick(next);
				}
			}}
		>
			<SelectTrigger
				size="sm"
				aria-label="Agent"
				className="min-w-0 gap-1.5 rounded-md border-0 px-1.5 py-0 text-xs font-normal hover:bg-muted data-[size=sm]:h-6 dark:bg-transparent dark:hover:bg-muted"
			>
				{shown}
			</SelectTrigger>
			<SelectContent alignItemWithTrigger={false} align="start" className="w-auto">
				{personas.map((one) => (
					<SelectItem key={one.id} value={one.id}>
						<Head look={one.look} color={one.color} size={18} className="shrink-0" />
						{one.name}
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}

// A message to one of Chat's agents, which makes the bar Chat's message box: under the input, a
// line as the one that names the model there, saying whom it goes to, and the round button that
// sends it. What no quick action does is sent as it was typed ("Send this to General"); what was
// said to an agent by name, without the name ("Send “pay the invoice” to Finance"). The agent is
// `suggested`, or another picked in the line. Enter in the bar's input sends it, as in Chat, and
// the app goes to the conversation, where the agent answers.
export function AgentWidget({
	text,
	quoted = false,
	personas,
	suggested,
	bar,
}: {
	// What is sent.
	text: string;
	// The sentence says it, as it is not all of what is typed.
	quoted?: boolean;
	personas: ChatPersona[];
	suggested: ChatPersona | null;
	bar: BarAction;
}) {
	const org = useOrgSlug();
	const [pickedId, setPickedId] = useState<string | null>(null);
	const persona = personas.find((candidate) => candidate.id === pickedId) ?? suggested;
	const [status, setStatus] = useWriteStatus(text);
	// Sent once, however fast Enter is pressed again.
	const sending = useRef(false);
	const busy = status.kind === 'saving' || status.kind === 'done';

	const send = () => {
		if (!persona || sending.current) {
			return;
		}
		sending.current = true;
		setStatus({kind: 'saving'});
		void postMessage(org, persona.id, text).then((result) => {
			if (result.isErr()) {
				sending.current = false;
				setStatus({kind: 'failed', message: writeErrorMessage(result.error)});
				return;
			}
			bar.done(`/${org}/chat/${persona.id}`);
		});
	};
	useBarAction(bar, send, persona !== null);

	if (!persona) {
		return null;
	}

	return (
		<section aria-label="Send to an agent" className="flex flex-col gap-1 px-4 pb-3 text-xs">
			<div className="flex items-center gap-2">
				<div className="flex min-w-0 flex-1 items-center gap-1 text-muted-foreground">
					<span className="shrink-0">Send</span>{' '}
					{quoted ? (
						<q className="min-w-0 truncate">{text}</q>
					) : (
						<span className="shrink-0">this</span>
					)}{' '}
					<span className="shrink-0">to</span>{' '}
					<AgentPicker personas={personas} persona={persona} onPick={setPickedId} />
				</div>
				<Button
					size="icon-sm"
					className="shrink-0 rounded-full"
					aria-label="Send"
					onClick={send}
					disabled={busy}
				>
					<ArrowUpIcon />
				</Button>
			</div>
			{status.kind === 'failed' && <p className="text-destructive">{status.message}</p>}
		</section>
	);
}
