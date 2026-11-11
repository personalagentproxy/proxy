import {Link} from 'react-router';
import {pillVariants} from '@/lib/pill-variants';
import {IntegrationLogo} from '@/components/brand-logo';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {onSignInClick} from '@/lib/desktop';
import {INTEGRATIONS, signInPath} from '@/lib/integrations';
import {useOrgSlug} from '@/hooks/use-org';

type Props = {
	name: string;
	// The collections the widget reads, as the catalog names them: `events`.
	collectionIds: string[];
	// What it asks for and why: "Connect a calendar to see your day and send invites from here."
	children: string;
};

// A widget with nothing connected to read: what it needs, and a button per integration that has
// one of its collections, which signs in and comes back to the new connection's page, saying it
// was added, or opens the integration's form.
export function ConnectWidget({name, collectionIds, children}: Props) {
	const org = useOrgSlug();
	const offering = INTEGRATIONS.filter(
		(integration) =>
			!integration.native &&
			integration.collections.some((collection) => collectionIds.includes(collection.id)),
	);

	return (
		<WidgetFrame
			name={name}
			actions={offering.map((integration) => {
				const className = pillVariants({variant: 'ghost'});
				const content = (
					<>
						<IntegrationLogo integration={integration} />
						Connect {integration.name}
					</>
				);
				const signIn = signInPath(org, integration.id);
				if (signIn) {
					return (
						<a key={integration.id} href={signIn} onClick={onSignInClick} className={className}>
							{content}
						</a>
					);
				}
				return (
					<Link
						key={integration.id}
						to={`/${org}/connections/new/${integration.id}`}
						className={className}
					>
						{content}
					</Link>
				);
			})}
		>
			<p>{children}</p>
		</WidgetFrame>
	);
}
