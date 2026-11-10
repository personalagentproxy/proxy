import {useState} from 'react';
import {useNavigate} from 'react-router';
import {createDrive} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ShareNote} from '@/components/share-choice';
import {Button} from '@proxy/ui/components/button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {useCommandEnterSubmit} from '@/hooks/use-command-enter';
import {useOrgSlug} from '@/hooks/use-org';
import {useShareChoice} from '@/hooks/use-share-choice';
import {describeApiError} from '@/lib/loader-utils';

// The form for a new drive, from the catalog's plus: a name, since its name is what tells it from
// the person's own and says to agents what belongs in it. Making it opens its page, on its files,
// none yet; who it is shared with is set there too, as any connection's is.
export function AddDrivePage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const {shared} = useShareChoice();
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const ready = name.trim() !== '';
	const form = useCommandEnterSubmit(ready && !pending);

	return (
		<AppShell title={<PageTitle>New drive</PageTitle>}>
			<form
				ref={form}
				className="grid gap-4"
				onSubmit={async (event) => {
					event.preventDefault();
					setPending(true);
					setError(null);
					const result = await createDrive(org, {name: name.trim(), ...(shared ? {shared} : {})});
					if (result.isErr()) {
						setPending(false);
						setError(describeApiError(result.error));
						return;
					}
					navigate(`/${org}/connections/${result.value.id}`);
				}}
			>
				<ShareNote />
				<p className="text-sm text-muted-foreground">
					A drive beside your own, for the files of more than you: a team's documents, a project's
					working files. Agents read it and put what they make in it, unless you say otherwise,
					every version of each file is kept, and you share it with whoever should have it.
				</p>
				<div className="grid gap-2">
					<Label htmlFor="drive-name">Name</Label>
					<Input
						id="drive-name"
						autoComplete="off"
						maxLength={80}
						placeholder="Launch plan"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<p className="text-sm text-muted-foreground">
						What this drive is called here and to agents, who go by it for what to put in it.
					</p>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<div>
					<Button type="submit" disabled={!ready || pending}>
						{pending ? 'Making it' : 'Make drive'}
					</Button>
				</div>
			</form>
		</AppShell>
	);
}
