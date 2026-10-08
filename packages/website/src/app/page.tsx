import {Button} from '@proxy/ui/components/button';
import {LogoDock} from '@/components/logo-dock';
import {LogoDockTuner} from '@/components/logo-dock-tuner';
import {RiseInWords, riseInDelay} from '@/components/rise-in-words';

// The app is its own origin: Vite's in development, app.personalagentproxy.com once built.
const APP_URL =
	process.env.NODE_ENV === 'development'
		? 'http://localhost:5173'
		: 'https://app.personalagentproxy.com';

const HEADLINE =
	'Personal Agent Proxy is one place for the accounts and information your AI agents work with.';

const PARAGRAPHS = [
	'Every new agent asks you to connect your email, your calendar and your notes again, and to trust one more company with all of them. Personal Agent Proxy turns that around. You connect your services once, here, and give each agent a login of its own. It signs in and works with what you allowed it: reading your inbox, writing a draft, sending an email. When you move to another agent, your connections come with you, like an adapter.',
	"The connections are yours, not the agent's. Nothing is copied from your services, and every request an agent makes is checked against what you allowed and written to a log, allowed or denied. Personal Agent Proxy is open source and designed to be self-hosted: one container and a Postgres database on your own server.",
];

// The words of the headline and the paragraphs are one run, top to bottom; a block's first word
// comes after every word above it, and the buttons after the last.
const wordCount = (texts: string[]) =>
	texts.reduce((words, text) => words + text.split(' ').length, 0);
const LINKS_WORD = wordCount([HEADLINE, ...PARAGRAPHS]);

// One column: the dock of logos, a sentence saying what it is, the manifesto, the app's two sign-in pages, and a
// footer that sits at the bottom when the page is shorter than the window. Clipped so the footer
// rising in from below the window doesn't flash a scrollbar.
export default function Home() {
	return (
		<main className="flex min-h-dvh w-full justify-center overflow-clip bg-background px-6 text-foreground">
			<div className="flex w-full max-w-xl flex-col">
				<div className="grid gap-8 pt-24">
					<LogoDock className="rise-in mb-4" />
					{process.env.NODE_ENV === 'development' && <LogoDockTuner />}
					<h1 className="text-2xl font-medium text-balance">
						<RiseInWords text={HEADLINE} firstWord={0} />
					</h1>
					<div className="grid gap-4 text-base text-muted-foreground">
						{PARAGRAPHS.map((paragraph, index) => (
							<p key={index}>
								<RiseInWords
									text={paragraph}
									firstWord={wordCount([HEADLINE, ...PARAGRAPHS.slice(0, index)])}
								/>
							</p>
						))}
					</div>
					<div className="rise-in flex gap-2" style={{animationDelay: riseInDelay(LINKS_WORD)}}>
						<Button nativeButton={false} render={<a href={`${APP_URL}/login`} />}>
							For humans
						</Button>
						<Button
							variant="outline"
							nativeButton={false}
							render={<a href={`${APP_URL}/agent/login`} />}
						>
							For agents
						</Button>
					</div>
				</div>
				<footer
					className="rise-in mt-auto flex justify-between gap-4 pt-24 pb-8 text-sm text-muted-foreground"
					style={{animationDelay: riseInDelay(LINKS_WORD)}}
				>
					<div>© 2026 Varis Labs, Inc.</div>
					<div className="flex gap-4">
						<a className="hover:text-foreground" href="https://docs.personalagentproxy.com">
							Docs
						</a>
						<a className="hover:text-foreground" href="https://github.com/personalagentproxy/proxy">
							GitHub
						</a>
					</div>
				</footer>
			</div>
		</main>
	);
}
