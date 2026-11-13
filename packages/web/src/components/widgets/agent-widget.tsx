import type {ChatPersona} from '@proxy/contracts/harness';
import {useRef, useState} from 'react';
import {openThread} from '@/client/harness-client';
import {Head} from '@/components/head';
import {EnterButton} from '@/components/widgets/enter-button';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {WidgetSelect} from '@/components/widgets/widget-select';
import {WriteResult} from '@/components/widgets/write-result';
import type {BarAction} from '@/hooks/use-bar-action';
import {useOrgSlug} from '@/hooks/use-org';
import {useWriteStatus} from '@/hooks/use-write-status';
import {writeErrorMessage} from '@/lib/write-status';

// The agent a message goes to, in the line that says so, as the model is named under Chat's
// message box: its head and its name, a picker of the others where there is more than one.
function AgentPicker({
	personas,
	persona,
	onPick,
}: {
	personas: ChatPersona[];
	persona: ChatPersona;
	onPick: (id: string) => void;
}) {
	if (personas.length < 2) {
		// Where the picker's name would be, as Chat's model is where it can't be changed.
		return (
			<span className="flex min-w-0 items-center gap-1.5 px-1.5">
				<Head look={persona.look} color={persona.color} size={16} className="shrink-0" />
				<span className="truncate text-foreground">{persona.name}</span>
			</span>
		);
	}

	return (
		<WidgetSelect
			label="Agent"
			options={personas.map((one) => ({
				value: one.id,
				label: one.name,
				icon: <Head look={one.look} color={one.color} size={16} className="shrink-0" />,
			}))}
			value={persona.id}
			onChange={onPick}
		/>
	);
}

// A message to one of Chat's agents, which makes the bar Chat's message box: under the input, a
// widget that is only its foot, a line as the one that names the model there, saying whom it goes
// to, beside the Send button, the card's main one. What no quick action does is sent as it was typed ("Send this to General"); what was
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
		void openThread(org, persona.id, text).then((result) => {
			if (result.isErr()) {
				sending.current = false;
				setStatus({kind: 'failed', message: writeErrorMessage(result.error)});
				return;
			}
			bar.done(`/${org}/chat/${persona.id}`);
		});
	};

	if (!persona) {
		return null;
	}

	// The whole card is its line beside the Send button, as the model's name is beside Chat's.
	return (
		<WidgetFrame
			name="Send to an agent"
			status={
				<div className="flex flex-col gap-1">
					<div className="flex min-w-0 items-center gap-1">
						<span className="shrink-0">Send</span>{' '}
						{quoted ? (
							<q className="min-w-0 truncate">{text}</q>
						) : (
							<span className="shrink-0">this</span>
						)}{' '}
						<span className="shrink-0">to</span>{' '}
						<AgentPicker personas={personas} persona={persona} onPick={setPickedId} />
					</div>
					<WriteResult status={status} />
				</div>
			}
			actions={
				<EnterButton bar={bar} onClick={send} disabled={busy}>
					Send
				</EnterButton>
			}
		/>
	);
}
