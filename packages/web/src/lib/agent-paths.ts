// What the address of a list inside `parent` adds, in a nested collection: `?parent=…`.
export function inside(parent: string | null): string {
	return parent ? `?parent=${encodeURIComponent(parent)}` : '';
}
