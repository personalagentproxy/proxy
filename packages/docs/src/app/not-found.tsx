import Link from 'next/link';

export default function NotFound() {
	return (
		<main className="mx-auto w-full max-w-3xl px-4 pt-24 pb-12 text-center">
			<h1 className="text-lg font-semibold">Page not found</h1>
			<p className="mt-2 text-sm text-muted-foreground">
				There is no page here. Start from the{' '}
				<Link href="/" className="font-medium text-foreground underline underline-offset-4">
					overview
				</Link>
				.
			</p>
		</main>
	);
}
