import type {ChatHarness} from '@proxy/contracts/harness';
import {CheckIcon, ChevronDownIcon} from 'lucide-react';
import {type KeyboardEvent, useState} from 'react';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {InputGroupButton} from '@proxy/ui/components/input-group';
import {PillButton} from '@/components/pill-button';

/** What runs an agent: the harness and the model it answers with, each by its id. */
export type ModelChoice = {harness: string; chatModel: string};

type Props = {
	// The harnesses the server has, each with its models.
	harnesses: ChatHarness[];
	// What runs the agent now.
	chosen: ModelChoice;
	// Whether the person may change it: they made the agent, or own the organization.
	mayChange: boolean;
	onPick: (choice: ModelChoice) => void;
};

const PANEL_ID = 'model-switcher-models';
const tabId = (harnessId: string) => `model-switcher-${harnessId}`;

// What runs the agent, under the conversation's input: the model, with the harness beside it. For
// whoever may change the agent it opens on the harnesses as tabs, the app's ghost pills, and under
// them the models of the one looked at, the model chosen checked on a gray row, and a gray tick on
// whichever other is pointed at. Looking at another harness changes nothing; picking a model takes
// its harness with it. For anyone else it only says what runs the agent. The choice is the
// agent's, for every member's conversation with it, from the next turn on. Nothing where the
// server has no harness.
export function ModelSwitcher({harnesses, chosen, mayChange, onPick}: Props) {
	const harness = harnesses.find((candidate) => candidate.id === chosen.harness) ?? harnesses[0];
	const model =
		harness?.models.find((candidate) => candidate.id === chosen.chatModel) ?? harness?.models[0];
	// The harness whose models are listed: the agent's as the list opens, then whichever was
	// clicked in the side column.
	const [lookedAt, setLookedAt] = useState<string | null>(null);
	if (!harness || !model) {
		return null;
	}

	const name = (
		<>
			<span className="text-foreground">{model.label}</span>
			<span className="text-muted-foreground">{harness.label}</span>
		</>
	);

	if (!mayChange) {
		return (
			<span
				className="flex h-5 items-center gap-1.5 border border-transparent px-1.5 text-xs font-normal"
				title="Whoever made this agent, or owns the organization, chooses what runs it."
			>
				{name}
			</span>
		);
	}

	const listed = harnesses.find((candidate) => candidate.id === lookedAt) ?? harness;

	// Left and right move between the tabs, as in any tablist, the one moved to looked at.
	const onTabsKeyDown = (event: KeyboardEvent) => {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') {
			return;
		}
		const step = event.key === 'ArrowRight' ? 1 : -1;
		event.preventDefault();
		event.stopPropagation();
		const index = harnesses.findIndex((candidate) => candidate.id === listed.id);
		const next = harnesses[(index + step + harnesses.length) % harnesses.length];
		if (!next) {
			return;
		}
		setLookedAt(next.id);
		document.getElementById(tabId(next.id))?.focus();
	};

	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (open) {
					setLookedAt(harness.id);
				}
			}}
		>
			<DropdownMenuTrigger
				render={
					<InputGroupButton
						aria-label={`Model: ${model.label} on ${harness.label}`}
						className="h-5 gap-1.5 rounded-full text-xs font-normal"
					/>
				}
			>
				{name}
				<ChevronDownIcon className="text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="w-60 p-0 shadow-none">
				<div
					role="tablist"
					aria-label="Harness"
					onKeyDown={onTabsKeyDown}
					className="flex flex-wrap gap-1 border-b p-1"
				>
					{harnesses.map((candidate) => (
						<PillButton
							key={candidate.id}
							id={tabId(candidate.id)}
							variant="ghost"
							role="tab"
							aria-selected={candidate.id === listed.id}
							aria-controls={PANEL_ID}
							tabIndex={candidate.id === listed.id ? 0 : -1}
							onClick={() => setLookedAt(candidate.id)}
						>
							{candidate.label}
						</PillButton>
					))}
				</div>
				<DropdownMenuRadioGroup
					id={PANEL_ID}
					aria-label={`${listed.label} models`}
					className="p-1"
					value={listed.id === harness.id ? model.id : ''}
					onValueChange={(chatModel: string) => onPick({harness: listed.id, chatModel})}
				>
					{listed.models.map((option) => {
						const chosenModel = listed.id === harness.id && option.id === model.id;
						return (
							<DropdownMenuRadioItem
								key={option.id}
								value={option.id}
								closeOnClick
								// The model chosen stands out by its row, as the harness looked at does by its
								// tab; any other, pointed at, shows a gray tick where picking it would put one,
								// and no background.
								className="group/model not-aria-checked:focus:bg-transparent aria-checked:bg-accent"
							>
								{option.label}
								{!chosenModel && (
									<CheckIcon
										aria-hidden
										data-slot="model-switcher-hover-tick"
										// The row colors everything in it as it is pointed at, the tick's strokes too, which
										// draw in their own color: both are held to the gray.
										className="absolute right-2 text-muted-foreground! opacity-0 group-focus/model:opacity-100 **:text-muted-foreground!"
									/>
								)}
							</DropdownMenuRadioItem>
						);
					})}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
