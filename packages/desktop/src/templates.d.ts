// build.ts bundles the splash pages, and their stylesheet, as text. (`*.html` is Bun's own
// `HTMLBundle` to @types/bun, so the pages are `.tpl.html`.)
declare module '*.tpl.html' {
	const content: string;
	export default content;
}

declare module '*.css' {
	const content: string;
	export default content;
}
