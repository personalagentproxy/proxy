import type {ChatPersona} from '@proxy/contracts/harness';
import {PillButton} from '@proxy/ui/components/pill-button';
import {DangerCard} from '@/components/danger-card';
import {LiveHead} from '@/components/head';

// Whose the agent is, in a line under its name.
function whoseLine(persona: ChatPersona, orgName: string): string {
	if (!persona.shared) {
		return 'Yours alone';
	}
	return `For everyone in ${orgName}`;
}

// What deleting the agent takes with it: the person's conversation with it, and for one every
// member sees, everyone's.
function deleteCardLine(persona: ChatPersona): string {
	const conversations = persona.shared
		? `Every member’s conversation with ${persona.name} goes with it.`
		: `Your conversation with ${persona.name} goes with it.`;
	return `${conversations} This cannot be undone.`;
}

// The pane's content, scrolling within itself: the agent, whose it is, and Edit, which opens its
// name and head in their dialog; and, at the pane's foot however short the rest, the card that
// deletes it. Without `mayChange`, it is read alone: neither Edit nor the card.
export function PersonaSettings({
	orgName,
	persona,
	onEdit,
	onDelete,
}: {
	orgName: string;
	persona: ChatPersona;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<section aria-label="Agent settings" className="flex min-h-0 flex-1 flex-col overflow-y-auto">
			<div className="flex w-full flex-1 flex-col gap-3 p-4">
				<div className="flex items-center gap-3.5 px-4 pb-2">
					<LiveHead look={persona.look} color={persona.color} size={72} />
					<div className="grid min-w-0 flex-1 gap-0.5">
						<span className="truncate text-[17px] leading-snug font-medium">{persona.name}</span>
						<span className="text-sm text-muted-foreground">{whoseLine(persona, orgName)}</span>
					</div>
					{persona.mayChange && (
						<PillButton type="button" variant="ghost" className="bg-muted" onClick={onEdit}>
							Edit
						</PillButton>
					)}
				</div>
				{persona.mayChange && (
					<div className="mt-auto pt-6">
						<DangerCard
							title={`Delete ${persona.name}`}
							description={deleteCardLine(persona)}
							button="Delete agent"
							onClick={onDelete}
						/>
					</div>
				)}
			</div>
		</section>
	);
}
