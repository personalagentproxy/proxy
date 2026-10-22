import {useSearchParams} from 'react-router';
import {ShareToggle} from '@/components/share-toggle';
import {useShareChoice} from '@/hooks/use-share-choice';

// Who a new connection is for, in an organization with anyone else in it or invited, chosen above
// the catalog and shown again on the connection's form (`hooks/use-share-choice.ts`).

// What a connection being shared or kept means, under the choice.
const CONNECTION = {
	shared:
		"Every member's agents can use it, as the account you connect: for a service you sign in to, that is you. Best for a team account, a shared mailbox or a database user.",
	own: 'Only you and your agents. Nobody else in the organization sees it, its owner included.',
};

// Above the catalog, or New agent: the choice, and what it means.
export function SharePicker({
	descriptions = CONNECTION,
}: {
	descriptions?: {shared: string; own: string};
}) {
	const [, setParams] = useSearchParams();
	const {organization, asked, shared} = useShareChoice();
	if (!asked || !organization) {
		return null;
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="flex items-center gap-2">
				<span className="text-sm text-muted-foreground">For</span>
				<ShareToggle
					orgName={organization.name}
					shared={shared}
					onChange={(next) => setParams(next ? {for: 'everyone'} : {}, {replace: true})}
				/>
			</div>
			<p className="text-sm text-muted-foreground">
				{shared ? descriptions.shared : descriptions.own}
			</p>
		</div>
	);
}

// On a connection's form: who it will be for, and a link that changes it there.
export function ShareNote({actsAs}: {actsAs: string}) {
	const [, setParams] = useSearchParams();
	const {organization, asked, shared} = useShareChoice();
	if (!asked || !organization) {
		return null;
	}

	return (
		<p className="text-sm text-muted-foreground">
			<span className="text-foreground">
				{shared ? `For everyone in ${organization.name}` : 'Just for you'}
			</span>
			{shared
				? ` · every member's agents can use it, as ${actsAs}. `
				: ` · nobody else in ${organization.name} sees it. `}
			<button
				type="button"
				onClick={() => setParams(shared ? {} : {for: 'everyone'}, {replace: true})}
				className="text-foreground underline underline-offset-4"
			>
				{shared ? 'Make it just mine' : `Share with everyone in ${organization.name}`}
			</button>
		</p>
	);
}
