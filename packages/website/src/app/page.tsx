import {Button} from '@proxy/ui/components/button';

// The app is its own origin: Vite's in development, app.personalagentproxy.com once built.
const APP_URL =
	process.env.NODE_ENV === 'development'
		? 'http://localhost:5173'
		: 'https://app.personalagentproxy.com';

// Laid out like the app's sign-in page, which each button leads to.
export default function Home() {
	return (
		<main className="flex min-h-dvh w-full items-center justify-center bg-background text-foreground">
			<div className="grid w-72 gap-4">
				<div className="grid gap-1">
					<h1 className="text-lg font-semibold">Personal Agent Proxy</h1>
					<p className="text-sm text-muted-foreground">More soon</p>
				</div>
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
		</main>
	);
}
