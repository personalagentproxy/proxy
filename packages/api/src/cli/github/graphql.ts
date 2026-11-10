import {type DocumentNode, type FragmentDefinitionNode, getOperationAST, Kind, parse, type SelectionSetNode} from 'graphql';
import {Result} from 'ts-results-es';

/**
 * Which operation a GraphQL request to GitHub runs, whether it is a query or a mutation, and the
 * fields at its root, for deciding which of the connection's actions it needs (needs.ts). The
 * document is read with GraphQL's own parser, so "mutation" in a comment or a string is no
 * operation, and fragments are no operation either. The one run is the one `operationName` names,
 * or the document's only one. Anything that doesn't parse, or doesn't say which operation runs, is
 * null, which the caller takes as needing the most.
 */

export type OperationType = 'query' | 'mutation' | 'subscription';

export type Operation = {type: OperationType; name: string | null};

/** An operation and its root fields by their names, not their aliases; null where a fragment at the root names none the document has. */
export type OperationRun = Operation & {fields: string[] | null};

// The root fields of a selection set, through the fragments in it, spread or inline; null where it spreads one the document doesn't have.
function rootFields(selections: SelectionSetNode, fragments: Map<string, FragmentDefinitionNode>, seen: string[]): string[] | null {
	const fields: string[] = [];
	for (const selection of selections.selections) {
		if (selection.kind === Kind.FIELD) {
			fields.push(selection.name.value);
			continue;
		}
		if (selection.kind === Kind.INLINE_FRAGMENT) {
			const inner = rootFields(selection.selectionSet, fragments, seen);
			if (inner === null) {
				return null;
			}
			fields.push(...inner);
			continue;
		}
		const name = selection.name.value;
		const fragment = fragments.get(name);
		if (!fragment || seen.includes(name)) {
			return null;
		}
		const inner = rootFields(fragment.selectionSet, fragments, [...seen, name]);
		if (inner === null) {
			return null;
		}
		fields.push(...inner);
	}
	return fields;
}

function fragmentsOf(document: DocumentNode): Map<string, FragmentDefinitionNode> {
	const fragments = new Map<string, FragmentDefinitionNode>();
	for (const definition of document.definitions) {
		if (definition.kind === Kind.FRAGMENT_DEFINITION) {
			fragments.set(definition.name.value, definition);
		}
	}
	return fragments;
}

/**
 * The operation a request runs: the one `operationName` names, else the document's only one. Null
 * where the document can't be read, has none, names none of its own, or has several and the
 * request doesn't say which.
 */
export function operationRun(document: string, operationName: string | null): OperationRun | null {
	const parsed = Result.wrap(() => parse(document, {noLocation: true}));
	if (parsed.isErr()) {
		return null;
	}
	const operation = getOperationAST(parsed.value, operationName);
	if (!operation) {
		return null;
	}
	return {
		type: operation.operation,
		name: operation.name?.value ?? null,
		fields: rootFields(operation.selectionSet, fragmentsOf(parsed.value), []),
	};
}
