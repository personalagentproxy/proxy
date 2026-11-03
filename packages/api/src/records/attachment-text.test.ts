import {describe, expect, test} from 'bun:test';
import * as XLSX from 'xlsx';

import {attachmentRecord, attachmentsText, pickAttachment, type AttachmentFile} from './attachment-text';

function file(name: string, type: string, bytes: Uint8Array): AttachmentFile {
	return {name, type, size: bytes.length, bytes};
}

const text = (value: string): Uint8Array => new TextEncoder().encode(value);

function spreadsheet(tabs: Record<string, XLSX.WorkSheet>): Uint8Array {
	const book = XLSX.utils.book_new();
	for (const [name, sheet] of Object.entries(tabs)) {
		XLSX.utils.book_append_sheet(book, sheet, name);
	}
	return new Uint8Array(XLSX.write(book, {type: 'array', bookType: 'xlsx'}));
}

// A zip of files kept as they are, uncompressed, as a .docx is read.
function zip(files: Record<string, string>): Uint8Array {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const nameBytes = Buffer.from(name);
		const data = Buffer.from(content);
		const crc = Bun.hash.crc32(data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(data.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, nameBytes, data);
		centrals.push(central, nameBytes);
		offset += local.length + nameBytes.length + data.length;
	}
	const directory = Buffer.concat(centrals);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(centrals.length / 2, 8);
	end.writeUInt16LE(centrals.length / 2, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

function wordDocument(paragraphs: string[]): Uint8Array {
	const body = paragraphs.map((paragraph) => `<w:p><w:r><w:t>${paragraph}</w:t></w:r></w:p>`).join('');
	return zip({
		'[Content_Types].xml':
			'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
		'_rels/.rels':
			'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
		'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
	});
}

// A one-page PDF with a line of text on it, or none.
function pdf(line: string | null): Uint8Array {
	const stream = line === null ? '' : `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
	const objects = [
		'<< /Type /Catalog /Pages 2 0 R >>',
		'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
		'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
		`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
		'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
	];
	let source = '%PDF-1.4\n';
	const offsets = objects.map((object, index) => {
		const at = source.length;
		source += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return at;
	});
	const xref = source.length;
	source += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
	source += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return text(source);
}

describe('attachmentsText', () => {
	test('lists each attachment on a line, numbered, with its type and size', () => {
		expect(
			attachmentsText([
				{name: 'Q3 budget.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 48_213},
				{name: 'photo.jpg', type: 'image/jpeg', size: 3_400_000},
				{name: '', type: '', size: 200},
			]),
		).toBe('1. Q3 budget.xlsx (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 47 KB)\n2. photo.jpg (image/jpeg, 3.2 MB)\n3. Untitled (unknown type, 200 B)');
	});
});

describe('pickAttachment', () => {
	const attachments = [
		{name: 'notes.txt', type: 'text/plain', size: 5},
		{name: 'Budget.xlsx', type: 'application/octet-stream', size: 9},
	];

	test('finds an attachment by its number, its name, or its name in any case', () => {
		expect(pickAttachment(attachments, {attachment: '2'}).unwrap()).toEqual({attachment: {name: 'Budget.xlsx', type: 'application/octet-stream', size: 9}, number: 2});
		expect(pickAttachment(attachments, {attachment: 'notes.txt'}).unwrap().number).toBe(1);
		expect(pickAttachment(attachments, {attachment: ' budget.XLSX '}).unwrap().number).toBe(2);
	});

	test('turns down one the email hasn’t, listing those it has', () => {
		const error = pickAttachment(attachments, {attachment: '3'}).unwrapErr();

		expect(error).toMatchObject({kind: 'validation_error'});
		expect(error.kind === 'validation_error' ? error.message : '').toBe(
			'This email has no attachment “3”. Its attachments are:\n1. notes.txt (text/plain, 5 B)\n2. Budget.xlsx (application/octet-stream, 9 B)',
		);
		expect(pickAttachment([], {attachment: '1'}).unwrapErr()).toMatchObject({message: 'This email has no attachments'});
		expect(pickAttachment(attachments, {}).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});
});

describe('attachmentRecord', () => {
	test('reads a spreadsheet as CSV, tab by tab, its values as Excel shows them, leaving out empty tabs', async () => {
		const overview: XLSX.WorkSheet = {
			'!ref': 'A1:E2',
			A1: {t: 's', v: 'System'},
			B1: {t: 's', v: 'Users'},
			C1: {t: 's', v: 'Since'},
			D1: {t: 's', v: 'Until'},
			E1: {t: 's', v: 'Cost'},
			A2: {t: 's', v: 'ERP, finance'},
			B2: {t: 'n', v: 140},
			// 1 March 2019 and 30 June 2025 at 14:30, in a format SheetJS can show and in a German one it can't.
			C2: {t: 'n', v: 43525, z: 'dd/mm/yyyy'},
			D2: {t: 'n', v: 45838.604166666664, z: 'dd.mm.yyyy hh:mm'},
			E2: {t: 'n', v: 1234.5, z: '#,##0.00 "€"'},
		};
		const bytes = spreadsheet({Overview: overview, Empty: XLSX.utils.aoa_to_sheet([]), Notes: XLSX.utils.aoa_to_sheet([['Archived “as is”']])});

		const record = (await attachmentRecord('msg-1', 2, file('Overview.xlsx', 'application/octet-stream', bytes))).unwrap();

		expect(record.id).toBe('msg-1/2');
		expect(record.values).toMatchObject({email: 'msg-1', attachment: '2', name: 'Overview.xlsx', type: 'application/octet-stream'});
		expect(record.values.content).toBe('Tab: Overview\nSystem,Users,Since,Until,Cost\n"ERP, finance",140,01/03/2019,2025-06-30 14:30,"1,234.50 €"\n\nTab: Notes\nArchived “as is”');
		expect(record.values.length).toBe(`${record.values.content?.length} characters`);
	});

	test('reads a Word document’s text', async () => {
		const record = (
			await attachmentRecord('msg-1', 1, file('Letter.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', wordDocument(['Dear Dana,', 'the review is on Friday.'])))
		).unwrap();

		expect(record.values.content).toBe('Dear Dana,\n\nthe review is on Friday.');
	});

	test('reads a PDF’s text, and turns down one with none, as a scan', async () => {
		const record = (await attachmentRecord('msg-1', 1, file('Invoice.pdf', 'application/pdf', pdf('Invoice 1042: 1,200 EUR')))).unwrap();

		expect(record.values.content).toBe('Invoice 1042: 1,200 EUR');
		expect((await attachmentRecord('msg-1', 1, file('Scan.pdf', 'application/pdf', pdf(null)))).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: '“Scan.pdf” has no text in it, as a scan hasn’t: only its pictures',
		});
	});

	test('reads a forwarded email with its headers and text', async () => {
		const source =
			'From: Dana <dana@example.com>\r\nTo: Sam <sam@example.com>\r\nSubject: Pricing review\r\nDate: Tue, 27 Oct 2026 09:00:00 +0000\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nSee you on Friday.\r\n';

		const record = (await attachmentRecord('msg-1', 1, file('Pricing review.eml', 'message/rfc822', text(source)))).unwrap();

		expect(record.values.content).toBe('From: "Dana" <dana@example.com>\nTo: "Sam" <sam@example.com>\nDate: 2026-10-27T09:00:00.000Z\nSubject: Pricing review\n\nSee you on Friday.');
	});

	test('reads text as it is, in its charset where it isn’t UTF-8, and HTML as text', async () => {
		expect((await attachmentRecord('m', 1, file('notes.csv', 'text/csv', text('a,b\r\n1,2')))).unwrap().values.content).toBe('a,b\n1,2');
		expect((await attachmentRecord('m', 1, file('notes.txt', 'text/plain; charset=iso-8859-1', new Uint8Array(Buffer.from('Grüße', 'latin1'))))).unwrap().values.content).toBe('Grüße');
		expect((await attachmentRecord('m', 1, file('page.html', 'text/html', text('<p>Hello &amp; welcome</p>')))).unwrap().values.content).toBe('Hello & welcome');
	});

	test('answers the first 100,000 characters of a long one, saying so', async () => {
		const record = (await attachmentRecord('m', 1, file('log.txt', 'text/plain', text('x'.repeat(150_000))))).unwrap();

		expect(record.values.content?.length).toBe(100_000);
		expect(record.values.length).toBe('The first 100000 of 150000 characters');
	});

	test('turns down images and other files, and a spreadsheet that isn’t one', async () => {
		expect((await attachmentRecord('m', 1, file('photo.jpg', 'image/jpeg', new Uint8Array([0xff, 0xd8])))).unwrapErr()).toMatchObject({
			kind: 'validation_error',
			message: '“photo.jpg” (image/jpeg) can’t be read as text: only spreadsheets, PDFs, Word documents, emails and text can',
		});
		expect((await attachmentRecord('m', 1, file('smime.p7s', 'application/pkcs7-signature', new Uint8Array([1])))).isErr()).toBe(true);
		expect((await attachmentRecord('m', 1, file('broken.docx', 'application/octet-stream', text('not a zip')))).unwrapErr()).toMatchObject({kind: 'validation_error'});
	});
});
