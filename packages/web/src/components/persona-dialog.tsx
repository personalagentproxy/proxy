import type {ChatHarness, Persona} from '@proxy/contracts/harness';
import {ShuffleIcon} from 'lucide-react';
import {useState} from 'react';
import {AGENT_NAME_MAX} from '@proxy/utils/agent-providers';
import {AVATAR_COLORS, type AvatarColor, shuffleLook} from '@proxy/utils/harness';
import {LiveHead} from '@/components/head';
import {Button} from '@proxy/ui/components/button';
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from '@proxy/ui/components/dialog';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {cn} from '@proxy/ui/lib/utils';
import {useCommandEnterSubmit} from '@/hooks/use-command-enter';

type Props = {
	open: boolean;
	// The persona as it is, to change; none to make one.
	initial: Persona | null;
	// The harnesses the server has for it to run on, each with its models; the first is a new one's.
	harnesses: ChatHarness[];
	onClose: () => void;
	// Saves the persona; what went wrong, shown in the dialog, or null once saved.
	onSave: (persona: Persona) => Promise<string | null>;
	// Deletes the persona with its conversation, where it is one that exists.
	onDelete?: () => Promise<string | null>;
};

// The colors as the stylesheet has them, for the swatches.
const BACKGROUND: Record<AvatarColor, string> = {
	mono: 'bg-avatar-mono',
	red: 'bg-avatar-red',
	orange: 'bg-avatar-orange',
	yellow: 'bg-avatar-yellow',
	green: 'bg-avatar-green',
	teal: 'bg-avatar-teal',
	blue: 'bg-avatar-blue',
	purple: 'bg-avatar-purple',
	pink: 'bg-avatar-pink',
};

// A new persona starts with a look of its own, and a color drawn from the nine.
function fresh(): Persona {
	return {
		name: '',
		look: shuffleLook(),
		color: AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)] ?? 'blue',
	};
}

// One of the two choices of what runs it, as a button each, the one chosen pressed.
function Choice({
	label,
	options,
	chosen,
	onPick,
}: {
	label: string;
	options: Array<{id: string; label: string}>;
	chosen: string;
	onPick: (id: string) => void;
}) {
	return (
		<div className="grid gap-2">
			<Label>{label}</Label>
			<div className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
				{options.map((option) => (
					<Button
						key={option.id}
						type="button"
						size="sm"
						variant={option.id === chosen ? 'secondary' : 'outline'}
						aria-pressed={option.id === chosen}
						onClick={() => onPick(option.id)}
					>
						{option.label}
					</Button>
				))}
			</div>
		</div>
	);
}

// What runs it: the harness first, with whose account its turns run on, then the model, one of
// those the harness has. Another harness starts from its first model.
function RunsOn({
	harnesses,
	harness,
	chatModel,
	onPick,
}: {
	harnesses: ChatHarness[];
	harness: ChatHarness;
	chatModel: string;
	onPick: (choice: {harness: string; chatModel: string}) => void;
}) {
	return (
		<>
			<div className="grid gap-2">
				<Choice
					label="Harness"
					options={harnesses}
					chosen={harness.id}
					onPick={(id) => {
						const picked = harnesses.find((candidate) => candidate.id === id);
						const first = picked?.models[0];
						if (!picked || !first || picked.id === harness.id) {
							return;
						}
						onPick({harness: picked.id, chatModel: first.id});
					}}
				/>
				<p className="text-sm text-muted-foreground">{harness.description}</p>
			</div>
			<Choice
				label="Model"
				options={harness.models}
				chosen={chatModel}
				onPick={(id) => onPick({harness: harness.id, chatModel: id})}
			/>
		</>
	);
}

// A round button the size of a swatch, for the colors and the one for another look.
const ROUND =
	'flex size-9 shrink-0 items-center justify-center rounded-full transition-[box-shadow,background-color] outline-none focus-visible:ring-3 focus-visible:ring-ring/50';

// Making a persona, or changing one: its name, and its head, which looks at the cursor as the
// person works, in one of the colors, with another look a click away; and what runs it, the
// harness and the model, of those the server has. Mount it keyed by what is edited, so the fields
// start from it.
export function PersonaDialog({open, initial, harnesses, onClose, onSave, onDelete}: Props) {
	const [persona, setPersona] = useState<Persona>(() => initial ?? fresh());
	// What runs it as chosen so far: the harness it has, or the server's first, and the model it
	// has of that harness's, or the harness's first. None on a server with no harness.
	const harness = harnesses.find((candidate) => candidate.id === persona.harness) ?? harnesses[0];
	const model =
		harness?.models.find((candidate) => candidate.id === persona.chatModel) ?? harness?.models[0];
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const ready = persona.name.trim() !== '';
	const form = useCommandEnterSubmit(ready && !busy);

	const finish = (failed: string | null) => {
		setBusy(false);
		setError(failed);
		if (failed === null) {
			onClose();
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					return;
				}
				onClose();
			}}
		>
			<DialogContent>
				<form
					ref={form}
					className="grid gap-5"
					onSubmit={async (event) => {
						event.preventDefault();
						if (!ready || busy) {
							return;
						}
						setBusy(true);
						finish(
							await onSave({
								...persona,
								name: persona.name.trim(),
								harness: harness?.id,
								chatModel: model?.id,
							}),
						);
					}}
				>
					<DialogHeader>
						<DialogTitle>{initial ? 'Edit agent' : 'New agent'}</DialogTitle>
						<DialogDescription>
							{initial
								? 'Its name, its head and what runs it. The conversation stays as it is.'
								: 'An agent for one kind of thing, such as Finance or Outreach, with a conversation that keeps going.'}
						</DialogDescription>
					</DialogHeader>
					<div className="flex items-center gap-5">
						<LiveHead look={persona.look} color={persona.color} size={112} />
						<div className="grid flex-1 gap-4">
							<div className="grid gap-2">
								<Label htmlFor="persona-name">Name</Label>
								<Input
									id="persona-name"
									autoFocus
									autoComplete="off"
									maxLength={AGENT_NAME_MAX}
									placeholder="Finance"
									value={persona.name}
									onChange={(event) => setPersona({...persona, name: event.target.value})}
								/>
							</div>
							<div className="grid w-fit grid-cols-5 gap-2" aria-label="Head">
								<div className="contents" role="radiogroup" aria-label="Color">
									{AVATAR_COLORS.map((candidate) => (
										<button
											key={candidate}
											type="button"
											role="radio"
											aria-checked={candidate === persona.color}
											aria-label={candidate}
											onClick={() => setPersona({...persona, color: candidate})}
											className={cn(
												ROUND,
												BACKGROUND[candidate],
												candidate === persona.color
													? 'ring-2 ring-foreground ring-offset-2 ring-offset-background'
													: 'hover:ring-2 hover:ring-border hover:ring-offset-2 hover:ring-offset-background',
											)}
										/>
									))}
								</div>
								<button
									type="button"
									aria-label="Another look"
									title="Another look"
									onClick={() => setPersona({...persona, look: shuffleLook()})}
									className={cn(
										ROUND,
										'border text-muted-foreground hover:bg-muted hover:text-foreground',
									)}
								>
									<ShuffleIcon className="size-4" />
								</button>
							</div>
						</div>
					</div>
					{harness && model && (
						<RunsOn
							harnesses={harnesses}
							harness={harness}
							chatModel={model.id}
							onPick={(choice) => setPersona({...persona, ...choice})}
						/>
					)}
					{error && <p className="text-sm text-destructive">{error}</p>}
					<DialogFooter>
						{onDelete && (
							<Button
								type="button"
								variant="destructive"
								className="mr-auto"
								disabled={busy}
								onClick={async () => {
									setBusy(true);
									finish(await onDelete());
								}}
							>
								Delete
							</Button>
						)}
						<Button type="button" variant="outline" onClick={onClose}>
							Cancel
						</Button>
						<Button type="submit" disabled={!ready || busy}>
							{busy ? 'Saving…' : initial ? 'Save' : 'Create'}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
