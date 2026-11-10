/**
 * Files, as the web app shows and addresses them. A drive is its connection's page, and where the
 * person is in it is in the page's query: the folder opened (`folder`), what is searched for in
 * it by name (`q`), a file shown over it (`file`), or the trash (`trash`). The api's link to a
 * file, which an agent hands the person (api native/files/links.ts), is the same address.
 */

/** Where in a drive the page's query says the person is. */
export type DrivePlace = {
	folder: string | null;
	file: string | null;
	trash: boolean;
	search: string | null;
};

export function drivePlace(params: URLSearchParams): DrivePlace {
	return {
		folder: params.get('folder'),
		file: params.get('file'),
		trash: params.has('trash'),
		search: params.get('q')?.trim() || null,
	};
}

/** The query for a place in a drive: `?folder=…&q=…&file=…`, `?trash`, or `?` for the top. */
export function driveQuery(place: Partial<DrivePlace>): string {
	const params = new URLSearchParams();
	if (place.trash) {
		params.set('trash', '');
	}
	if (place.folder && !place.trash) {
		params.set('folder', place.folder);
	}
	if (place.search && !place.trash) {
		params.set('q', place.search);
	}
	if (place.file) {
		params.set('file', place.file);
	}
	// The trash's own address is `?trash`, without the `=` an empty value is written with.
	return `?${params.toString().replace(/^trash=(&|$)/, 'trash$1')}`;
}

/** What a file is, as far as its icon says: read from its name's extension, else its media type. */
export type FileKind = 'image' | 'sheet' | 'text' | 'code' | 'archive' | 'audio' | 'video' | 'file';

const KINDS: Array<[FileKind, string[]]> = [
	['image', ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic', 'bmp', 'tiff']],
	['sheet', ['csv', 'tsv', 'xls', 'xlsx', 'xlsm', 'ods', 'numbers']],
	['text', ['txt', 'md', 'markdown', 'pdf', 'doc', 'docx', 'rtf', 'log', 'eml']],
	[
		'code',
		[
			'json',
			'xml',
			'yaml',
			'yml',
			'toml',
			'html',
			'css',
			'js',
			'ts',
			'tsx',
			'jsx',
			'py',
			'sh',
			'sql',
		],
	],
	['archive', ['zip', 'gz', 'tar', 'tgz', '7z', 'rar']],
	['audio', ['mp3', 'wav', 'm4a', 'ogg', 'flac']],
	['video', ['mp4', 'mov', 'webm', 'mkv', 'avi']],
];

export function fileKind(name: string, type?: string): FileKind {
	const extension = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase() ?? '';
	const byName = KINDS.find(([, extensions]) => extensions.includes(extension))?.[0];
	if (byName) {
		return byName;
	}
	const family = type?.split('/')[0];
	if (family === 'image' || family === 'audio' || family === 'video' || family === 'text') {
		return family;
	}
	return 'file';
}
