import {useState} from 'react';
import {useNavigate} from 'react-router';
import {createVault} from '@/client/connections-client';
import {AppShell, PageTitle} from '@/components/app-shell';
import {ShareNote} from '@/components/share-choice';
import {PillButton} from '@/components/pill-button';
import {Input} from '@proxy/ui/components/input';
import {Label} from '@proxy/ui/components/label';
import {useCommandEnterSubmit} from '@/hooks/use-command-enter';
import {useOrgSlug} from '@/hooks/use-org';
import {useShareChoice} from '@/hooks/use-share-choice';
import {describeApiError} from '@/lib/loader-utils';

// The form for a new vault, from the catalog's plus: a name, since its name is what tells it from
// the person's own and says to agents what belongs in it. Making it opens its page, on its
// entries, none yet; who it is shared with is set there too, as any connection's is.
export function AddVaultPage() {
	const org = useOrgSlug();
	const navigate = useNavigate();
	const {shared} = useShareChoice();
	const [name, setName] = useState('');
	const [error, setError] = useState<string | null>(null);
	const [pending, setPending] = useState(false);
	const ready = name.trim() !== '';
	const form = useCommandEnterSubmit(ready && !pending);

	return (
		<AppShell title={<PageTitle>New vault</PageTitle>}>
			<form
				ref={form}
				className="grid gap-4"
				onSubmit={async (event) => {
					event.preventDefault();
					setPending(true);
					setError(null);
					const result = await createVault(org, {name: name.trim(), ...(shared ? {shared} : {})});
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
					A vault beside your own, for what more than your own agents should know: a team's ways of
					working, a project's facts. Agents read it and keep what they learn in it, unless you say
					otherwise, and you share it with whoever should have it.
				</p>
				<div className="grid gap-2">
					<Label htmlFor="vault-name">Name</Label>
					<Input
						id="vault-name"
						autoComplete="off"
						maxLength={80}
						placeholder="Team handbook"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					<p className="text-sm text-muted-foreground">
						What this vault is called here and to agents, who go by it for what to keep in it.
					</p>
				</div>
				{error && <p className="text-sm text-destructive">{error}</p>}
				<div>
					<PillButton type="submit" disabled={!ready || pending}>
						{pending ? 'Making it' : 'Make vault'}
					</PillButton>
				</div>
			</form>
		</AppShell>
	);
}
