import type {LucideIcon} from 'lucide-react';
import {Link} from 'react-router';
import {buttonVariants} from '@proxy/ui/components/button';
import {IntegrationLogo} from '@/components/brand-logo';
import {WidgetFrame} from '@/components/widgets/widget-frame';
import {INTEGRATIONS, signInPath} from '@/lib/integrations';
import {useOrgSlug} from '@/hooks/use-org';

type Props = {
	icon: LucideIcon;
	name: string;
	// The collections the widget reads, as the catalog names them: `events`.
	collectionIds: string[];
	// What it asks for and why: "Connect a calendar to see your day and send invites from here."
	children: string;
};

// A widget with nothing connected to read: what it needs, and a button per integration that has
// one of its collections, which signs in and comes back to the home page, or opens the integration's form.
export function ConnectWidget({icon, name, collectionIds, children}: Props) {
	const org = useOrgSlug();
	const offering = INTEGRATIONS.filter(
		(integration) =>
			!integration.builtIn &&
			integration.collections.some((collection) => collectionIds.includes(collection.id)),
	);

	return (
		<WidgetFrame
			icon={icon}
			name={name}
			actions={offering.map((integration) => {
				const className = buttonVariants({size: 'sm', variant: 'outline'});
				const content = (
					<>
						<IntegrationLogo integration={integration} />
						Connect {integration.name}
					</>
				);
				const signIn = signInPath(org, integration.id, {returnTo: 'home'});
				if (signIn) {
					return (
						<a key={integration.id} href={signIn} className={className}>
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
