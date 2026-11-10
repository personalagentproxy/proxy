import type {ChatHarness} from '@proxy/contracts/harness';
import {ChevronDownIcon} from 'lucide-react';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuLabel,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@proxy/ui/components/dropdown-menu';
import {InputGroupButton} from '@proxy/ui/components/input-group';

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
// whoever may change the agent it opens the models to switch between, under the harness each
// runs on, with whose account that is, the one chosen checked; for anyone else it only says. The
// choice is the agent's, for every member's conversation with it, from the next turn on. Nothing
// where the server has no harness.
export function ModelSwitcher({harnesses, chosen, mayChange, onPick}: Props) {
	const harness = harnesses.find((candidate) => candidate.id === chosen.harness) ?? harnesses[0];
	const model =
		harness?.models.find((candidate) => candidate.id === chosen.chatModel) ?? harness?.models[0];
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
				className="flex items-center gap-1.5 px-1.5 text-xs font-normal"
				title="Whoever made this agent, or owns the organization, chooses what runs it."
			>
				{name}
			</span>
		);
	}

	return (
		<DropdownMenu>
			<DropdownMenuTrigger
				render={
					<InputGroupButton
						aria-label={`Model: ${model.label} on ${harness.label}`}
						className="gap-1.5 font-normal"
					/>
				}
			>
				{name}
				<ChevronDownIcon className="text-muted-foreground" />
			</DropdownMenuTrigger>
			<DropdownMenuContent side="top" align="start" className="w-72">
				{harnesses.map((candidate, index) => (
					<DropdownMenuGroup key={candidate.id}>
						{index > 0 && <DropdownMenuSeparator />}
						<DropdownMenuLabel className="grid gap-0.5">
							<span className="text-foreground">{candidate.label}</span>
							<span className="font-normal">{candidate.description}</span>
						</DropdownMenuLabel>
						<DropdownMenuRadioGroup
							value={candidate.id === harness.id ? model.id : ''}
							onValueChange={(chatModel: string) => onPick({harness: candidate.id, chatModel})}
						>
							{candidate.models.map((option) => (
								<DropdownMenuRadioItem key={option.id} value={option.id} closeOnClick>
									{option.label}
								</DropdownMenuRadioItem>
							))}
						</DropdownMenuRadioGroup>
					</DropdownMenuGroup>
				))}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
