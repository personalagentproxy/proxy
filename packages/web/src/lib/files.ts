/**
 * Files, as the web app shows and addresses them. A drive is its connection's page, and where the
 * person is in it is in the page's query: the folder opened (`folder`), a file shown over it
 * (`file`), or the trash (`trash`). The api's link to a file, which an agent hands the person
 * (api native/files/links.ts), is the same address.
 */

/** Where in a drive the page's query says the person is. */
export type DrivePlace = {folder: string | null; file: string | null; trash: boolean};

export function drivePlace(params: URLSearchParams): DrivePlace {
	return {folder: params.get('folder'), file: params.get('file'), trash: params.has('trash')};
}

/** The query for a place in a drive: `?folder=…&file=…`, `?trash`, or `?` for the top. */
export function driveQuery(place: Partial<DrivePlace>): string {
	if (place.trash) {
		return '?trash';
	}
	const params = new URLSearchParams();
	if (place.folder) {
		params.set('folder', place.folder);
	}
	if (place.file) {
		params.set('file', place.file);
	}
	return `?${params.toString()}`;
}
