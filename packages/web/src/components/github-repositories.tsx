import type {GitHubInstallation} from '@proxy/contracts/github';
import {ExternalLinkIcon} from 'lucide-react';
import {useState} from 'react';
import {Badge} from '@proxy/ui/components/badge';
import {buttonVariants} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import {EmptyRows, Row, RowList} from '@/components/row-list';
import {formatAgo} from '@/lib/format';
import type {GitHubReach} from '@/lib/github';

/**
 * The Repositories part of a GitHub connection's page, the first of its tabs: the repositories
 * the connection reaches, as GitHub decided them, grouped by the account the app is installed on,
 * each group saying whether the installation covers all of the account's repositories or a
 * selection, with the way to change that on GitHub. Personal Agent Proxy never picks repositories
 * itself; this reflects GitHub, and "Add repositories" opens GitHub's own install page, which asks
 * which account and which repositories.
 */

// A group longer than this is cut, the rest behind "Show all".
const SHOWN = 5;

// The columns after the name.
const CELLS = {
	visibility: 'w-20 shrink-0',
	pushed: 'hidden w-28 shrink-0 text-right text-muted-foreground md:block',
};

const EXTERNAL_LINK =
	'flex shrink-0 items-center gap-1 underline-offset-4 hover:text-foreground hover:underline';

function ExternalLink({
	href,
	children,
	className,
}: {
	href: string;
	children: string;
	className?: string;
}) {
	return (
		<a href={href} target="_blank" rel="noreferrer" className={className}>
			{children}
			<ExternalLinkIcon aria-hidden className="size-3" />
		</a>
	);
}

function VisibilityBadge({visibility}: {visibility: 'Public' | 'Private'}) {
	return (
		<Badge variant={visibility === 'Private' ? 'secondary' : 'outline'} className="font-normal">
			{visibility}
		</Badge>
	);
}

// What an installation covers: all of the account's repositories, or the ones picked, GitHub
// having listed only so many where there are more.
function coverageOf(installation: GitHubInstallation): string {
	if (installation.all) {
		return 'all repositories';
	}
	const count = installation.repositories.length;
	return `${installation.more ? `${count} or more` : count} of its repositories`;
}

// One account the app is installed on: what the installation covers, its repositories, and where
// to change them, on the line the row lists put their column names.
function InstallationGroup({installation}: {installation: GitHubInstallation}) {
	const [showAll, setShowAll] = useState(false);
	const {account, repositories, settingsUrl} = installation;
	const shown =
		showAll || repositories.length <= SHOWN ? repositories : repositories.slice(0, SHOWN);

	return (
		<div className="flex flex-col">
			<div className="bleed flex h-8 items-center gap-3 text-xs text-muted-foreground">
				<span className="min-w-0 flex-1 truncate">
					<span className="font-medium text-foreground">{account}</span> ·{' '}
					{coverageOf(installation)}
				</span>
				<ExternalLink href={settingsUrl} className={EXTERNAL_LINK}>
					Manage on GitHub
				</ExternalLink>
			</div>
			<RowList>
				{repositories.length === 0 && (
					<EmptyRows>No repositories picked for this account yet.</EmptyRows>
				)}
				{shown.map((repository) => (
					<Row
						key={repository.fullName}
						onClick={() => window.open(repository.url, '_blank', 'noreferrer')}
						title={repository.fullName}
						cells={
							<>
								<span className={CELLS.visibility}>
									<VisibilityBadge visibility={repository.visibility} />
								</span>
								<span className={CELLS.pushed}>
									{repository.pushedAt ? formatAgo(repository.pushedAt) : ''}
								</span>
							</>
						}
					/>
				))}
				{shown.length < repositories.length && (
					<li className="-mx-(--bleed)">
						<button
							type="button"
							onClick={() => setShowAll(true)}
							className="h-8 px-(--bleed) text-left text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
						>
							Show all {repositories.length}
							{installation.more ? ' listed' : ''}
						</button>
					</li>
				)}
			</RowList>
		</div>
	);
}

// What the tab says while the app is installed nowhere the person reaches: the one thing to do.
function NotInstalled({installUrl}: {installUrl: string}) {
	return (
		<div className="flex flex-col items-start gap-3 rounded-lg border border-dashed p-4">
			<p className="text-sm text-muted-foreground">
				The app isn’t installed on any GitHub account you can reach, so agents see no repositories
				yet. Install it on your account or an organization and pick the repositories; they show up
				here.
			</p>
			<ExternalLink
				href={installUrl}
				className={cn(buttonVariants({variant: 'default', size: 'sm'}), 'gap-1.5')}
			>
				Install on GitHub
			</ExternalLink>
		</div>
	);
}

type Props = {
	// The GitHub login the connection is signed in as.
	account: string;
	// Whether the connection is shared, so the tab says whose GitHub the agents reach.
	shared: boolean;
	reach: GitHubReach;
};

export function GitHubRepositories({account, shared, reach}: Props) {
	const whose = shared
		? `What agents reach on GitHub as ${account}`
		: 'What your agents reach on GitHub';
	if ('error' in reach) {
		return (
			<div className="flex flex-col gap-2">
				<p className="flex min-h-8 items-center text-sm text-muted-foreground">
					{whose}, as the app is installed
				</p>
				<p className="text-sm text-destructive">{reach.error}</p>
			</div>
		);
	}
	const {installations, installUrl} = reach;

	return (
		<div className="flex flex-col gap-2">
			<div className="flex min-h-8 items-center justify-between gap-4 text-sm text-muted-foreground">
				<span>{whose}, as the app is installed</span>
				{installations.length > 0 && (
					<ExternalLink href={installUrl} className={EXTERNAL_LINK}>
						Add repositories
					</ExternalLink>
				)}
			</div>
			{installations.length === 0 && <NotInstalled installUrl={installUrl} />}
			{installations.length > 0 && (
				<div className="flex flex-col gap-4">
					{installations.map((installation) => (
						<InstallationGroup key={installation.settingsUrl} installation={installation} />
					))}
				</div>
			)}
		</div>
	);
}
