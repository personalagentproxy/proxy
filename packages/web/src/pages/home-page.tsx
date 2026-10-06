import {useState} from 'react';
import {Button} from '@/components/ui/button';

export function HomePage() {
	const [count, setCount] = useState(0);

	return (
		<main className="flex min-h-svh flex-col items-center justify-center gap-4 p-6">
			<h1 className="text-2xl font-semibold">Proxy</h1>
			<p className="text-muted-foreground">Clicked {count} times</p>
			<div className="flex gap-2">
				<Button onClick={() => setCount(count + 1)}>Click me</Button>
				<Button variant="outline" onClick={() => setCount(0)} disabled={count === 0}>
					Reset
				</Button>
			</div>
		</main>
	);
}
