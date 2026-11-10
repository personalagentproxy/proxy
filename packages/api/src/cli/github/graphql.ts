import {getOperationAST, parse} from 'graphql';
import {Result} from 'ts-results-es';

/**
 * Which operation a GraphQL request to GitHub runs, and whether it is a query or a mutation, for
 * deciding whether it needs Read or Write (requests.ts). The document is read with GraphQL's own
 * parser, so "mutation" in a comment or a string is no operation, and fragments are no operation
 * either. The one run is the one `operationName` names, or the document's only one. Anything that
 * doesn't parse, or doesn't say which operation runs, is null, which the caller takes as a write.
 */

export type OperationType = 'query' | 'mutation' | 'subscription';

export type Operation = {type: OperationType; name: string | null};

/**
 * The operation a request runs: the one `operationName` names, else the document's only one. Null
 * where the document can't be read, has none, names none of its own, or has several and the
 * request doesn't say which.
 */
export function operationRun(document: string, operationName: string | null): Operation | null {
	const parsed = Result.wrap(() => parse(document, {noLocation: true}));
	if (parsed.isErr()) {
		return null;
	}
	const operation = getOperationAST(parsed.value, operationName);
	if (!operation) {
		return null;
	}
	return {type: operation.operation, name: operation.name?.value ?? null};
}
