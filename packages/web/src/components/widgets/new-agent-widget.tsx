import {BotIcon} from 'lucide-react';
import {useRef, useState} from 'react';
import {AGENT_NAME_MAX} from '@proxy/utils/agent-providers';
import {AVATAR_COLORS, shuffleLook} from '@proxy/utils/harness';
import {createPersona, postMessage, saveDraft} from '@/client/harness-client';
import type {Intent} from '@/client/intent-client';
import {LiveHead} from '@/components/head';
import {EnterHint} from '@/components/widgets/enter-hint';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {WriteResult} from '@/components/widgets/write-result';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Textarea} from '@proxy/ui/components/textarea';
import {type BarAction, useBarAction} from '@/hooks/use-bar-action';
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
	const org = useOrgSlug();
	const [name, setName] = useSuggested(
		(fieldTexts(intent, 'agentName')[0] ?? '').slice(0, AGENT_NAME_MAX),
	);
	const [task, setTask] = useSuggested(fieldTexts(intent, 'agentTask')[0] ?? '');
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
			const sent = await postMessage(org, id, said);
			// The agent is made all the same: what it was to be told waits in its conversation, as
			// typed and not sent.
			if (sent.isErr()) {
				await saveDraft(org, id, said);
			}
		}
		bar.done(`/${org}/chat/${id}`);
	};
	useBarAction(bar, () => void create(), named);

	return (
		<WidgetFrame
			icon={BotIcon}
			name="New agent"
			status={<WriteResult status={status} />}
			actions={
				<Button size="sm" onClick={() => void create()} disabled={!named || busy}>
					Create agent
					{bar.onEnter && <EnterHint />}
				</Button>
			}
		>
			<div className="flex items-center gap-3">
				<button
					type="button"
					aria-label="Another look"
					title="Another look"
					onClick={() => setHead(freshHead())}
					className="shrink-0 rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				>
					<LiveHead look={head.look} color={head.color} size={48} />
				</button>
				<Input
					aria-label="Name"
					placeholder="Name"
					autoComplete="off"
					maxLength={AGENT_NAME_MAX}
					value={name}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void create();
						}
					}}
				/>
			</div>
			<Textarea
				aria-label="What it does"
				placeholder="What should it do? You can also tell it in the conversation."
				rows={2}
				value={task}
				onChange={(event) => setTask(event.target.value)}
			/>
		</WidgetFrame>
	);
}
