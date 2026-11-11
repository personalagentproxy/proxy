import type {OrgPerson} from '@/lib/access';
import {PersonAvatar} from '@/components/person-avatar';
import {Tooltip, TooltipContent, TooltipTrigger} from '@proxy/ui/components/tooltip';

// How many heads a row shows before the rest are a count.
const MAX_HEADS = 4;

const HEAD = 'size-6 ring-2 ring-background';

function nameOf(person: OrgPerson): string {
	return person.name ?? person.email;
}

// A person's face, naming them on hover.
export function PersonHead({person}: {person: OrgPerson}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={<span role="img" aria-label={nameOf(person)} className="rounded-full" />}
			>
				<PersonAvatar person={person} className={HEAD} />
			</TooltipTrigger>
			<TooltipContent>{nameOf(person)}</TooltipContent>
		</Tooltip>
	);
}

// People's faces, overlapping, each naming its person on hover; past a handful, the rest as a
// count naming them all.
export function PersonHeads({people}: {people: OrgPerson[]}) {
	const shown = people.slice(0, MAX_HEADS);
	const rest = people.slice(MAX_HEADS);
	return (
		<span className="flex -space-x-1.5">
			{shown.map((person) => (
				<PersonHead key={person.userId} person={person} />
			))}
			{rest.length > 0 && (
				<Tooltip>
					<TooltipTrigger
						render={
							<span
								className={`relative flex items-center justify-center rounded-full bg-muted text-[10px] text-muted-foreground tabular-nums ${HEAD}`}
							/>
						}
					>
						+{rest.length}
					</TooltipTrigger>
					<TooltipContent>{rest.map(nameOf).join(', ')}</TooltipContent>
				</Tooltip>
			)}
		</span>
	);
}
