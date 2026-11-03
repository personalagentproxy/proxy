import {Result} from 'ts-results-es';

const UTF8 = new TextDecoder('utf-8', {fatal: true});

/**
 * Text from its bytes: as UTF-8 where they are UTF-8, else in the charset named, Windows-1252
 * where none is named or TextDecoder doesn't know it. Bytes that read as UTF-8 are taken as UTF-8
 * whatever charset is named, since text in another charset seldom is: a part's content can come
 * as UTF-8 while its Content-Type names another charset, as from Gmail, and read as that charset
 * turns ä into Ã¤.
 */
export function decodeText(bytes: Uint8Array, charset: string | null): string {
	const utf8 = Result.wrap(() => UTF8.decode(bytes));
	if (utf8.isOk()) {
		return utf8.value;
	}
	return Result.wrap(() => new TextDecoder(charset ?? 'windows-1252').decode(bytes)).unwrapOr(new TextDecoder('windows-1252').decode(bytes));
}
