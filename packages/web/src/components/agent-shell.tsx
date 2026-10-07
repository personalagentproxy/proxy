import {Fragment, type ReactNode} from 'react';
import {Link, useNavigate} from 'react-router';
import {signOutAgent} from '@/client/agent-client';
import {Button} from '@proxy/ui/components/button';
import {useAgentMe} from '@/hooks/use-agent-target';

// The agent side's frame. Built for a model driving a browser: no sidebar, no icon-only controls
// and nothing that only shows on hover, so every action is a labeled link or button on the page.
export function AgentShell({children}: {children: ReactNode}) {
	const navigate = useNavigate();
	const agent = useAgentMe()?.agent;

	return (
		<div className="flex min-h-dvh w-full flex-col bg-background text-foreground">
			<header className="sticky top-0 z-20 flex h-12 items-center justify-between gap-4 border-b bg-background px-4">
				<Link to="/agent" className="shrink-0 text-sm font-medium whitespace-nowrap">
					Personal Agent Proxy <span className="font-normal text-muted-foreground">for agents</span>
				</Link>
				<div className="flex min-w-0 items-center gap-3">
					{/* Desktop only: a phone's header has room for the brand and the button, not the name too. */}
					{agent && (
						<span className="hidden truncate text-sm text-muted-foreground md:inline">
							Signed in as {agent.name}
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
