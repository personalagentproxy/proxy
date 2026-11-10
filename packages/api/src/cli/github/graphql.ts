/**
 * Which operation a GraphQL request to GitHub runs, and whether it is a query or a mutation, for
 * deciding whether it needs Read or Write (requests.ts). The document is read as GraphQL reads it:
 * its tokens, comments and strings skipped, so "mutation" in a comment or a string is no
 * operation, and fragments are no operation either. The one run is the one `operationName` names,
 * or the document's only one. Anything this can't read, or can't tell, is null, which the caller
 * takes as a write.
 */

export type OperationType = 'query' | 'mutation' | 'subscription';

export type Operation = {type: OperationType; name: string | null};

type Token = {kind: 'name' | 'punct' | 'value'; text: string};

const PUNCTUATORS = '!$&()...:=@[]{|}';
const NAME_START = /[_A-Za-z]/;
const NAME_PART = /[_0-9A-Za-z]/;
const NUMBER_PART = /[-+.0-9eE]/;
const IGNORED = /[\s,﻿]/;

// Where a string starting at `at` ends, just past its closing quotes; -1 where it never does.
function stringEnd(source: string, at: number): number {
	if (source.startsWith('"""', at)) {
		for (let index = at + 3; index < source.length; index++) {
			if (source.startsWith('\\"""', index)) {
				index += 3;
				continue;
			}
			if (source.startsWith('"""', index)) {
				return index + 3;
			}
		}
		return -1;
	}
	for (let index = at + 1; index < source.length; index++) {
		const char = source[index];
		if (char === '\\') {
			index++;
			continue;
		}
		if (char === '\n' || char === '\r') {
			return -1;
		}
		if (char === '"') {
			return index + 1;
		}
	}
	return -1;
}

// The document's tokens, comments and whatever GraphQL ignores left out; null for one that isn't GraphQL.
function tokenize(source: string): Token[] | null {
	const tokens: Token[] = [];
	let at = 0;
	while (at < source.length) {
		const char = source[at] ?? '';
		if (IGNORED.test(char)) {
			at++;
			continue;
		}
		if (char === '#') {
			const lineEnd = source.slice(at).search(/[\n\r]/);
			at = lineEnd === -1 ? source.length : at + lineEnd;
			continue;
		}
		if (char === '"') {
			const end = stringEnd(source, at);
			if (end === -1) {
				return null;
			}
			tokens.push({kind: 'value', text: source.slice(at, end)});
			at = end;
			continue;
		}
		if (source.startsWith('...', at)) {
			tokens.push({kind: 'punct', text: '...'});
			at += 3;
			continue;
		}
		if (PUNCTUATORS.includes(char) && char !== '.') {
			tokens.push({kind: 'punct', text: char});
			at++;
			continue;
		}
		if (NAME_START.test(char)) {
			let end = at + 1;
			while (end < source.length && NAME_PART.test(source[end] ?? '')) {
				end++;
			}
			tokens.push({kind: 'name', text: source.slice(at, end)});
			at = end;
			continue;
		}
		if (char === '-' || /[0-9]/.test(char)) {
			let end = at + 1;
			while (end < source.length && NUMBER_PART.test(source[end] ?? '')) {
				end++;
			}
			tokens.push({kind: 'value', text: source.slice(at, end)});
			at = end;
			continue;
		}
		return null;
	}
	return tokens;
}

// Past the group opening at `at`, its nested groups of the same brackets with it; -1 where it never closes.
function skipGroup(tokens: Token[], at: number, open: string, close: string): number {
	let depth = 0;
	for (let index = at; index < tokens.length; index++) {
		const text = tokens[index]?.kind === 'punct' ? tokens[index]?.text : null;
		if (text === open) {
			depth++;
		}
		if (text === close) {
			depth--;
		}
		if (depth === 0) {
			return index + 1;
		}
	}
	return -1;
}

// Past a definition's head, its name, type condition, variables and directives, and its selection set; -1 where it is cut short.
function skipToSelectionEnd(tokens: Token[], at: number): number {
	let index = at;
	while (index < tokens.length) {
		const token = tokens[index];
		if (token?.kind === 'punct' && token.text === '{') {
			return skipGroup(tokens, index, '{', '}');
		}
		if (token?.kind === 'punct' && token.text === '(') {
			const end = skipGroup(tokens, index, '(', ')');
			if (end === -1) {
				return -1;
			}
			index = end;
			continue;
		}
		index++;
	}
	return -1;
}

function isOperationType(text: string): text is OperationType {
	return text === 'query' || text === 'mutation' || text === 'subscription';
}

/** The document's operations, in order; null for a document that isn't one GraphQL can run. */
export function operationsOf(document: string): Operation[] | null {
	const tokens = tokenize(document);
	if (tokens === null) {
		return null;
	}
	const operations: Operation[] = [];
	let at = 0;
	while (at < tokens.length) {
		const token = tokens[at];
		if (token?.kind === 'punct' && token.text === '{') {
			operations.push({type: 'query', name: null});
		}
		const isFragment = token?.kind === 'name' && token.text === 'fragment';
		const type = token?.kind === 'name' && isOperationType(token.text) ? token.text : null;
		if (type !== null) {
			const next = tokens[at + 1];
			operations.push({type, name: next?.kind === 'name' ? next.text : null});
		}
		const isDefinition = (token?.kind === 'punct' && token.text === '{') || isFragment || type !== null;
		if (!isDefinition) {
			return null;
		}
		const end = skipToSelectionEnd(tokens, at);
		if (end === -1) {
			return null;
		}
		at = end;
	}
	return operations;
}

/**
 * The operation a request runs: the one `operationName` names, else the document's only one. Null
 * where the document can't be read, has none, names none of its own, or has several and the
 * request doesn't say which.
 */
export function operationRun(document: string, operationName: string | null): Operation | null {
	const operations = operationsOf(document);
	if (operations === null) {
		return null;
	}
	if (operationName !== null) {
		return operations.find((operation) => operation.name === operationName) ?? null;
	}
	return operations.length === 1 ? (operations[0] ?? null) : null;
}
