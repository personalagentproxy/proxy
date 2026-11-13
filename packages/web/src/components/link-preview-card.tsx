import {useEffect, useState, type ComponentProps, type ReactNode} from 'react';
import {PreviewCard, PreviewCardContent, PreviewCardTrigger} from '@proxy/ui/components/preview-card';

type LinkPreview = {
	url: string;
	title: string | null;
	description: string | null;
	siteName: string;
	image: string | null;
};

const OPEN_DELAY_MS = 400;
const CLOSE_DELAY_MS = 150;

// What the server found of each page, kept for as long as the page is open: a link met again
// opens its card at once. A page it couldn't read is kept as null.
const found = new Map<string, Promise<LinkPreview | null>>();

function previewOf(href: string): Promise<LinkPreview | null> {
	let preview = found.get(href);
	if (!preview) {
		preview = fetch(`/api/link-previews?url=${encodeURIComponent(href)}`)
			.then((response) => (response.ok ? (response.json() as Promise<LinkPreview>) : null))
			.catch(() => null);
		found.set(href, preview);
	}
	return preview;
}

function usePreview(href: string): LinkPreview | null | undefined {
	const [state, setState] = useState<{href: string; preview: LinkPreview | null} | null>(null);
	useEffect(() => {
		let current = true;
		void previewOf(href).then((preview) => {
			if (current) {
				setState({href, preview});
			}
		});
		return () => {
			current = false;
		};
	}, [href]);
	return state?.href === href ? state.preview : undefined;
}

function CardBody({href}: {href: string}) {
	const preview = usePreview(href);
	const host = new URL(href).hostname.replace(/^www\./, '');
	if (preview === undefined) {
		return (
			<div className="space-y-2 p-3" aria-busy="true">
				<div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
				<div className="h-4 w-4/5 animate-pulse rounded bg-muted" />
				<div className="h-3 w-full animate-pulse rounded bg-muted" />
			</div>
		);
	}
	return (
		<a
			href={href}
			target="_blank"
			rel="noreferrer"
			className="block outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
		>
			{preview?.image && (
				<img
					src={`/api/link-previews/image?url=${encodeURIComponent(preview.image)}`}
					alt=""
					loading="lazy"
					className="aspect-[1.91/1] w-full bg-muted object-cover"
					onError={(event) => {
						event.currentTarget.hidden = true;
					}}
				/>
			)}
			<div className="space-y-1 p-3">
				<div className="truncate text-xs text-muted-foreground">{preview?.siteName ?? host}</div>
				<div className="line-clamp-2 text-sm font-medium break-words">{preview?.title ?? href}</div>
				{preview?.description && (
					<div className="line-clamp-3 text-xs break-words text-muted-foreground">
						{preview.description}
					</div>
				)}
			</div>
		</a>
	);
}

/**
 * A link to a page elsewhere that opens a card over it when the pointer rests on it, saying what
 * the page says of itself. The page is read by this app's server, never by the browser, so
 * nothing of whoever hovers reaches it.
 */
function LinkPreviewCard({
	href,
	children,
	...props
}: Omit<ComponentProps<'a'>, 'href'> & {href: string; children?: ReactNode}) {
	return (
		<PreviewCard>
			<PreviewCardTrigger
				delay={OPEN_DELAY_MS}
				closeDelay={CLOSE_DELAY_MS}
				render={<a href={href} target="_blank" rel="noreferrer" {...props} />}
			>
				{children}
			</PreviewCardTrigger>
			<PreviewCardContent>
				<CardBody href={href} />
			</PreviewCardContent>
		</PreviewCard>
	);
}

export {LinkPreviewCard};

