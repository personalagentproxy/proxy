/// <reference types="bun" />
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {join, relative} from 'node:path';
import ts from 'typescript';

import {expect, test} from 'bun:test';

// The bordered button is used sparingly: for a second way forward beside the dark one, and as much
// a way forward as it. Every place it is is listed here, so another is added on purpose, where it
// can be seen in review; most other buttons are ghost.
const OUTLINE_ALLOWED = ['packages/web/src/pages/login-page.tsx'];

const ROOT = join(import.meta.dir, '../../../..');
const PACKAGES = join(ROOT, 'packages');

// Every source file of every package: what is under each one's `src`.
function sources(directory: string): string[] {
	return readdirSync(directory, {withFileTypes: true}).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === 'node_modules') {
				return [];
			}
			return sources(path);
		}
		if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) {
			return [];
		}
		return [path];
	});
}

// Whether `node` says 'outline' anywhere in it: `"outline"`, or `{shown ? 'outline' : 'ghost'}`.
function saysOutline(node: ts.Node): boolean {
	if (ts.isStringLiteralLike(node) && node.text === 'outline') {
		return true;
	}
	return ts.forEachChild(node, saysOutline) ?? false;
}

// Whether a file draws an outline button: `<PillButton variant="outline">`, or
// `pillButtonVariants({variant: 'outline'})` for a link drawn as one.
function drawsOutline(name: string, source: string): boolean {
	const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
	const visit = (node: ts.Node): boolean => {
		if (
			(ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) &&
			node.tagName.getText(file) === 'PillButton' &&
			node.attributes.properties.some(
				(attribute) =>
					ts.isJsxAttribute(attribute) &&
					attribute.name.getText(file) === 'variant' &&
					attribute.initializer !== undefined &&
					saysOutline(attribute.initializer),
			)
		) {
			return true;
		}
		if (
			ts.isCallExpression(node) &&
			node.expression.getText(file) === 'pillButtonVariants' &&
			node.arguments.some(saysOutline)
		) {
			return true;
		}
		return ts.forEachChild(node, visit) ?? false;
	};
	return visit(file);
}

const packageSources = readdirSync(PACKAGES, {withFileTypes: true})
	.filter((entry) => entry.isDirectory())
	.map((entry) => join(PACKAGES, entry.name, 'src'))
	.filter((src) => existsSync(src))
	.flatMap(sources);

test('the outline button is only where it is allowed', () => {
	const outlined = packageSources
		.filter((path) => drawsOutline(path, readFileSync(path, 'utf8')))
		.map((path) => relative(ROOT, path));

	expect(
		outlined.toSorted(),
		'An outline PillButton is for a second way forward as much as the dark one beside it ("Continue with Google" beside "Send sign-in link"); most other buttons are ghost. Where one is meant, add its file to OUTLINE_ALLOWED in packages/ui/src/lib/pill-variants.test.ts.',
	).toEqual(OUTLINE_ALLOWED.toSorted());
});

test('the check finds an outline button however it is written, and nothing else', () => {
	expect(drawsOutline('a.tsx', '<PillButton variant="outline">Go</PillButton>')).toBe(true);
	expect(drawsOutline('a.tsx', "<PillButton variant={wide ? 'outline' : 'ghost'} />")).toBe(true);
	expect(drawsOutline('a.tsx', "const c = pillButtonVariants({variant: 'outline'});")).toBe(true);
	expect(drawsOutline('a.tsx', '<PillButton variant="ghost">Go</PillButton>')).toBe(false);
	expect(drawsOutline('a.tsx', '<Badge variant="outline">New</Badge>')).toBe(false);
});
