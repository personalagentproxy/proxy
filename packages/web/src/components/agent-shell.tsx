import type {Collection} from '@proxy/integrations';
import {Fragment, type ReactNode} from 'react';
import {Link, useNavigate, useParams} from 'react-router';
import {signOutAgent} from '@/client/agent-client';
import {AgentLogo} from '@/components/brand-logo';
import {Button} from '@proxy/ui/components/button';
import {cn} from '@proxy/ui/lib/utils';
import {useAgentMe} from '@/hooks/use-agent-target';

// The agent side's frame. Built for a model driving a browser: no sidebar, no icon-only controls
// and nothing that only shows on hover, so every action is a labeled link or button on the page.
// Every page but the feedback form ends with a link to it, about the connection and the tool it is on.
export function AgentShell({children, feedback = true}: {children: ReactNode; feedback?: boolean}) {
	const navigate = useNavigate();
	const agent = useAgentMe()?.agent;
	const {connectionId, toolName} = useParams();
	const about = new URLSearchParams({
		...(connectionId ? {connection: connectionId} : {}),
		...(toolName ? {tool: toolName} : {}),
	}).toString();

	return (
		<div className="flex min-h-dvh w-full flex-col bg-background text-foreground">
			<header className="sticky top-0 z-20 flex h-12 items-center justify-between gap-4 border-b bg-background px-4">
				<Link to="/agent" className="shrink-0 text-sm font-medium whitespace-nowrap">
					Personal Agent Proxy <span className="font-normal text-muted-foreground">for agents</span>
				</Link>
				<div className="flex min-w-0 items-center gap-3">
					{/* Desktop only: a phone's header has room for the brand and the button, not the name too. */}
					{agent && (
						<span className="hidden min-w-0 items-center gap-2 text-sm text-muted-foreground md:flex">
							<AgentLogo providerId={agent.providerId} />
							<span className="truncate">Signed in as {agent.name}</span>
						</span>
					)}
					<Button
						size="sm"
						variant="outline"
						onClick={async () => {
							await signOutAgent();
							navigate('/agent/login');
						}}
					>
						Sign out
					</Button>
				</div>
			</header>
			<main className="mx-auto w-full max-w-3xl px-4 pt-6 pb-12">{children}</main>
			{feedback && (
				<footer className="mx-auto w-full max-w-3xl px-4 pb-8 text-sm text-muted-foreground md:px-7">
					Something here not working as you expected?{' '}
					<Link
						to={about ? `/agent/feedback?${about}` : '/agent/feedback'}
						className="underline underline-offset-4 hover:text-foreground"
					>
						Send feedback
					</Link>{' '}
					to the makers of Personal Agent Proxy.
				</footer>
			)}
		</div>
	);
}

export type Crumb = {label: string; to?: string};

// Where the page sits, from the agent's home down, each step above the current one a link.
export function Crumbs({items}: {items: Crumb[]}) {
	return (
		<nav
			aria-label="Breadcrumb"
			className="mb-4 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground md:px-3"
		>
			{items.map((item, index) => (
				<Fragment key={index}>
					{index > 0 && <span aria-hidden>/</span>}
					{item.to ? (
						<Link to={item.to} className="underline-offset-4 hover:text-foreground hover:underline">
							{item.label}
						</Link>
					) : (
						<span className="text-foreground" aria-current="page">
							{item.label}
						</span>
					)}
				</Fragment>
			))}
		</nav>
	);
}

// The page's own heading, with what the agent may do here beside it.
export function AgentHeading({children, detail}: {children: ReactNode; detail?: string}) {
	return (
		<h1 className="text-lg font-semibold">
			{children}
			{detail && <span className="ml-2 text-sm font-normal text-muted-foreground">{detail}</span>}
		</h1>
	);
}

// What the person can open: these pages only open with the agent's login, so a record is shown to
// them by its link in the provider's own app, or, where it has none, named.
export function PersonLinkHint({collection}: {collection: Collection}) {
	const title = collection.fields.find((field) => field.key === collection.titleField);
	const text = collection.openIn
		? `To show the person ${collection.name.toLowerCase()}, give them the links in ${collection.openIn}, never the address of a page here: only this login can open these pages.`
		: `The person can’t open these pages: only this login can. Tell them which ${collection.singular} you mean by its ${title?.label.toLowerCase() ?? 'title'} instead.`;
	return <p className="mb-4 text-sm text-muted-foreground md:px-3">{text}</p>;
}

// A record's link in the provider's app, "Open in Gmail", opening in a new tab.
export function OpenInLink({
	collection,
	url,
	className,
}: {
	collection: Collection;
	url: string;
	className?: string;
}) {
	return (
		<a
			href={url}
			target="_blank"
			rel="noreferrer"
			className={cn('underline underline-offset-4 hover:text-foreground', className)}
		>
			{collection.openIn ? `Open in ${collection.openIn}` : 'Open'}
		</a>
	);
}
