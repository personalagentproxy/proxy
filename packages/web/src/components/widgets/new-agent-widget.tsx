import {useRef, useState} from 'react';
import {AGENT_NAME_MAX} from '@proxy/utils/agent-providers';
import {AVATAR_COLORS, shuffleLook} from '@proxy/utils/harness';
import {createPersona, openThread, saveDraft} from '@/client/harness-client';
import type {Intent} from '@/client/intent-client';
import {LiveHead} from '@/components/head';
import {EnterButton} from '@/components/widgets/enter-button';
import {WidgetFrame, WidgetInput, WidgetTextarea} from '@/components/widgets/widget-frame';
import {WriteResult} from '@/components/widgets/write-result';
import type {BarAction} from '@/hooks/use-bar-action';
import {useOrgSlug} from '@/hooks/use-org';
import {useSuggested} from '@/hooks/use-suggested';
import {useWriteStatus} from '@/hooks/use-write-status';
import {fieldTexts} from '@/lib/widget-values';
import {writeErrorMessage} from '@/lib/write-status';

// A head for a new agent: a look of its own, in one of the colors.
function freshHead() {
	return {
		look: shuffleLook(),
		color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] ?? 'blue',
	};
}

// New agent: one of Chat's, the person's own, named after what it is for and told what to do as
// its first message, both as the model read them from what was typed and as the person changes
// them here. Enter in the bar's input makes it, and the app goes to the conversation with it,
// where it is already at work.
export function NewAgentWidget({
	intent,
	typed,
	bar,
}: {
	intent: Intent;
	typed: string;
	bar: BarAction;
}) {
	return (
		<AgentMaker
			suggestedName={fieldTexts(intent, 'agentName')[0] ?? ''}
			suggestedTask={fieldTexts(intent, 'agentTask')[0] ?? ''}
			typed={typed}
			bar={bar}
		/>
	);
}

// What no quick action does, where there is no agent in Chat to send it to, as in an organization
// whose agents were all deleted: it says so, and offers to make one, told what was typed as its
// first message, once the person names it.
export function NoAgentWidget({typed, bar}: {typed: string; bar: BarAction}) {
	return (
		<AgentMaker
			lead="There is no agent to send this to yet. Make one, and it starts on this."
			suggestedName=""
			suggestedTask={typed}
			typed={typed}
			bar={bar}
		/>
	);
}

// The card that makes an agent, named and told what to do as suggested, under `lead` where there is
// one.
function AgentMaker({
	lead,
	suggestedName,
	suggestedTask,
	typed,
	bar,
}: {
	lead?: string;
	suggestedName: string;
	suggestedTask: string;
	typed: string;
	bar: BarAction;
}) {
	const org = useOrgSlug();
	const [name, setName] = useSuggested(suggestedName.slice(0, AGENT_NAME_MAX));
	const [task, setTask] = useSuggested(suggestedTask);
	const [head, setHead] = useState(freshHead);
	const [status, setStatus] = useWriteStatus(typed);
	// Made once, however fast Enter is pressed again.
	const making = useRef(false);
	const busy = status.kind === 'saving' || status.kind === 'done';
	const named = name.trim() !== '';

	const create = async () => {
		if (!named || making.current) {
			return;
		}
		making.current = true;
		setStatus({kind: 'saving'});
		const made = await createPersona(org, {name: name.trim(), ...head});
		if (made.isErr()) {
			making.current = false;
			setStatus({kind: 'failed', message: writeErrorMessage(made.error)});
			return;
		}
		const {id} = made.value.persona;
		const said = task.trim();
		if (said !== '') {
			const sent = await openThread(org, id, said);
			// The agent is made all the same: what it was to be told waits in its conversation, as
			// typed and not sent.
			if (sent.isErr()) {
				await saveDraft(org, id, said);
			}
		}
		bar.done(`/${org}/chat/${id}`);
	};

	return (
		<WidgetFrame
			name="New agent"
			status={<WriteResult status={status} />}
			actions={
				<EnterButton bar={bar} onClick={() => void create()} disabled={!named || busy}>
					Create agent
				</EnterButton>
			}
		>
			{lead !== undefined && <p className="text-muted-foreground">{lead}</p>}
			{/* As an agent's row in Chat's list: its head, its name, and under it what is said first. */}
			<div className="flex items-start gap-3">
				<button
					type="button"
					aria-label="Another look"
					title="Another look"
					onClick={() => setHead(freshHead())}
					className="shrink-0 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				>
					<LiveHead look={head.look} color={head.color} size={44} />
				</button>
				<div className="flex min-w-0 flex-1 flex-col gap-0.5">
					<WidgetInput
						aria-label="Name"
						placeholder="Name"
						autoComplete="off"
						maxLength={AGENT_NAME_MAX}
						className="font-medium"
						value={name}
						onChange={(event) => setName(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
								event.preventDefault();
								void create();
							}
						}}
					/>
					<WidgetTextarea
						aria-label="What it does"
						placeholder="What should it do? You can also tell it in the conversation."
						rows={1}
						className="text-muted-foreground"
						value={task}
						onChange={(event) => setTask(event.target.value)}
					/>
				</div>
			</div>
		</WidgetFrame>
	);
}
