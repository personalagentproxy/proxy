import type {Metadata} from 'next';
import Link from 'next/link';
import {ArrowLeftIcon, ArrowRightIcon} from 'lucide-react';
import {SidebarTrigger} from '@proxy/ui/components/sidebar';
import {mdxComponents} from '@/components/mdx-components';
import {TableOfContents} from '@/components/table-of-contents';
import {loadNav, loadPage, type NavPage} from '@/lib/docs';

// Every page is built ahead of time; a path not in src/nav.ts is a 404.
export const dynamicParams = false;

export async function generateStaticParams() {
	const nav = await loadNav();
	if (nav.isErr()) {
		throw nav.error;
	}

	return nav.value.pages.map((page) => ({slug: page.slug === '' ? [] : page.slug.split('/')}));
}

async function load(params: PageProps<'/[[...slug]]'>['params']) {
	const {slug = []} = await params;
	const page = await loadPage(slug.join('/'));
	// Content that does not compile fails the build here.
	if (page.isErr()) {
		throw page.error;
	}
	return {slug: slug.join('/'), page: page.value};
}

export async function generateMetadata({params}: PageProps<'/[[...slug]]'>): Promise<Metadata> {
	const {page} = await load(params);
	return {title: page.frontmatter.title, description: page.frontmatter.description};
}

export default async function DocPage({params}: PageProps<'/[[...slug]]'>) {
	const {slug, page} = await load(params);
	const nav = await loadNav();
	if (nav.isErr()) {
		throw nav.error;
	}

	const pages = nav.value.pages;
	const index = pages.findIndex((entry) => entry.slug === slug);
	const section = nav.value.sections.find((entry) => entry.pages.some((p) => p.slug === slug));
	const {Content, frontmatter, headings} = page;

	return (
		<>
			<header className="sticky top-0 z-20 flex h-12 items-center gap-2 border-b bg-background px-4">
				<SidebarTrigger className="md:hidden" />
				<span className="truncate text-sm font-medium">{frontmatter.title}</span>
				{section && (
					<span className="hidden text-xs text-muted-foreground md:inline">{section.title}</span>
				)}
			</header>
			<main className="mx-auto w-full max-w-3xl px-4 pt-8 pb-16 xl:grid xl:max-w-5xl xl:grid-cols-[minmax(0,1fr)_13rem] xl:gap-12">
				<article className="min-w-0 text-sm">
					<h1 className="text-2xl font-semibold tracking-tight">{frontmatter.title}</h1>
					<p className="mt-2 text-base text-muted-foreground">{frontmatter.description}</p>
					<div className="mt-8">
						<Content components={mdxComponents} />
					</div>
					<PageLinks previous={pages[index - 1]} next={pages[index + 1]} />
				</article>
				<aside className="hidden xl:block">
					<div className="sticky top-20">
						<TableOfContents headings={headings} />
					</div>
				</aside>
			</main>
		</>
	);
}

// The pages before and after this one in the sidebar's order.
function PageLinks({previous, next}: {previous?: NavPage; next?: NavPage}) {
	return (
		<nav className="mt-14 grid grid-cols-2 gap-4 border-t pt-6">
			{previous && (
				<Link
					href={previous.href}
					className="flex flex-col gap-1 rounded-lg border px-4 py-3 hover:bg-muted/50"
				>
					<span className="flex items-center gap-1 text-xs text-muted-foreground">
						<ArrowLeftIcon className="size-3" />
						Previous
					</span>
					<span className="font-medium">{previous.title}</span>
				</Link>
			)}
			{next && (
				<Link
					href={next.href}
					className="col-start-2 flex flex-col items-end gap-1 rounded-lg border px-4 py-3 hover:bg-muted/50"
				>
					<span className="flex items-center gap-1 text-xs text-muted-foreground">
						Next
						<ArrowRightIcon className="size-3" />
					</span>
					<span className="font-medium">{next.title}</span>
				</Link>
			)}
		</nav>
	);
}
