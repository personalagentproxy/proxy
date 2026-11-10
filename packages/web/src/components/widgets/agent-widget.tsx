import type {ChatPersona} from '@proxy/contracts/harness';
import {useRef, useState} from 'react';
import {postMessage} from '@/client/harness-client';
import {Head} from '@/components/head';
import {EnterHint} from '@/components/widgets/enter-hint';
import {Button} from '@proxy/ui/components/button';
import {Select, SelectContent, SelectItem, SelectTrigger} from '@proxy/ui/components/select';
import {type BarAction, useBarAction} from '@/hooks/use-bar-action';
import {useOrgSlug} from '@/hooks/use-org';
import {useWriteStatus} from '@/hooks/use-write-status';
import {writeErrorMessage} from '@/lib/write-status';

// The agent a message goes to, in the sentence that says so: its head and its name, which open
// the agents to pick another from where there is more than one.
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
			<Head look={persona.look} color={persona.color} size={20} className="shrink-0" />
			<span className="truncate font-medium">{persona.name}</span>
		</>
	);
	if (personas.length < 2) {
		return (
			<span className="inline-flex max-w-full -translate-y-px items-center gap-1.5 align-middle">
				{shown}
			</span>
		);
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
				className="inline-flex max-w-full -translate-y-px gap-1.5 border-0 px-1 py-0 align-middle text-sm hover:bg-muted data-[size=sm]:h-7 dark:bg-transparent dark:hover:bg-muted"
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

// A message to one of Chat's agents, in one sentence: what no quick action does, said as it was
// typed ("Send this to General."), or what was said to an agent by name, without the name ("Send
// “pay the invoice” to Finance"). The agent is `suggested`, or another picked in the sentence.
// Enter in the bar's input sends it, and the app goes to the conversation, where the agent answers.
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
		<section aria-label="Send to an agent" className="flex flex-col gap-2 p-4 text-sm">
			<div className="flex items-center gap-3">
				<p className="min-w-0 flex-1 leading-7">
					Send {quoted ? <q className="text-muted-foreground">{text}</q> : 'this'} to{' '}
					<AgentPicker personas={personas} persona={persona} onPick={setPickedId} />
					{!quoted && '.'}
				</p>
				<Button size="sm" className="shrink-0" onClick={send} disabled={busy}>
					Send
					{bar.onEnter && <EnterHint />}
				</Button>
			</div>
			{status.kind === 'failed' && <p className="text-destructive">{status.message}</p>}
		</section>
	);
}
