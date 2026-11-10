import type {ChatHarness} from '@proxy/contracts/harness';
import {CheckIcon, ChevronDownIcon} from 'lucide-react';
import {useState} from 'react';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {InputGroupButton} from '@proxy/ui/components/input-group';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';
import {cn} from '@proxy/ui/lib/utils';
import {HarnessLogo} from '@/components/brand-logo';

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

// What runs the agent, under the conversation's input: the model, with the harness beside it. For
// whoever may change the agent it opens in two columns: the harnesses down the side, each by its
// mark alone, named as the pointer rests on it, and beside them the models of the one looked at,
// the model chosen checked on a gray row, and a gray tick on whichever other is pointed at. Looking at another harness changes nothing; picking a model takes its harness
// with it. For anyone else it only says what runs the agent. The choice is the agent's, for every
// member's conversation with it, from the next turn on. Nothing where the server has no harness.
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
						className="h-5 gap-1.5 text-xs font-normal"
					/>
				}
			>
				{name}
				<ChevronDownIcon className="text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="flex w-60 p-0">
				<DropdownMenuGroup
					aria-label="Harness"
					className="flex shrink-0 flex-col gap-1 border-r bg-muted/40 p-1"
				>
					{harnesses.map((candidate) => (
						<Tooltip key={candidate.id}>
							<TooltipTrigger
								render={
									<DropdownMenuItem
										closeOnClick={false}
										aria-label={candidate.label}
										aria-current={candidate.id === listed.id}
										onClick={() => setLookedAt(candidate.id)}
										className={cn('p-1.5', candidate.id === listed.id && 'bg-accent')}
									/>
								}
							>
								<HarnessLogo harnessId={candidate.id} className="size-6" />
							</TooltipTrigger>
							<TooltipContent side="left">{candidate.label}</TooltipContent>
						</Tooltip>
					))}
				</DropdownMenuGroup>
				<DropdownMenuRadioGroup
					aria-label={`${listed.label} models`}
					className="min-h-24 min-w-0 flex-1 p-1"
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
								// tile; any other, pointed at, shows a gray tick where picking it would put one,
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
