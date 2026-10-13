import {z} from 'zod';

import {findIntegration} from './catalog';
import type {Action, Integration} from './types';

// A custom MCP server's tools, as the server lists them (`tools/list`), are what an agent can be
// allowed with a connection of it: one action per tool, the tool's name its id. The rest of the
// catalog describes an integration in advance; a custom server's tools are its own, so the list is
// kept on the connection and the integration built from it (`integrationFor`).

// One property of a tool's input, as far as the agent side's form reads it; anything else the
// server wrote, such as a nested object's own properties, is kept as it is.
export const mcpSchemaPropertySchema = z.looseObject({
	type: z.union([z.string(), z.array(z.string())]).optional(),
	description: z.string().optional(),
	enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
});

export type McpSchemaProperty = z.infer<typeof mcpSchemaPropertySchema>;

// A tool's JSON Schema, an object of properties.
export const mcpInputSchemaSchema = z.looseObject({
	type: z.string().optional(),
	properties: z.record(z.string(), mcpSchemaPropertySchema).optional(),
	required: z.array(z.string()).optional(),
});

export type McpInputSchema = z.infer<typeof mcpInputSchemaSchema>;

// What a tool says about itself: whether it only reads, and whether what it changes can be undone.
// A tool without annotations may do anything, which is how it is treated.
export const mcpToolAnnotationsSchema = z.object({
	title: z.string().optional(),
	readOnlyHint: z.boolean().optional(),
	destructiveHint: z.boolean().optional(),
	idempotentHint: z.boolean().optional(),
	openWorldHint: z.boolean().optional(),
});

export const mcpToolSchema = z.object({
	name: z.string().min(1),
	title: z.string().optional(),
	description: z.string().optional(),
	inputSchema: mcpInputSchemaSchema,
	annotations: mcpToolAnnotationsSchema.optional(),
});

export type McpTool = z.infer<typeof mcpToolSchema>;

// What the activity log names as the collection of a custom server's tool run, which has none.
export const TOOLS_COLLECTION_ID = 'tools';

// The length the connection page's line about a tool is kept to.
const SUMMARY_LENGTH = 160;

/** What a tool is called: its title, else its annotations' title, else its name. */
export function mcpToolTitle(tool: McpTool): string {
	return tool.title?.trim() || tool.annotations?.title?.trim() || tool.name;
}

/** Whether a tool only reads, as it says of itself. */
export function mcpToolReadsOnly(tool: McpTool): boolean {
	return tool.annotations?.readOnlyHint === true;
}

/**
 * How much harm a mistake with a tool does, from what it says of itself: low when it only reads,
 * medium when it changes something it says can be undone, else high, since a tool that says
 * nothing may do anything.
 */
export function mcpToolRisk(tool: McpTool): Action['risk'] {
	if (mcpToolReadsOnly(tool)) {
		return 'low';
	}
	if (tool.annotations?.destructiveHint === false) {
		return 'medium';
	}
	return 'high';
}

// The first line of a tool's description, kept short, for the line under its name.
function summarize(description: string | undefined): string {
	const line =
		(description ?? '')
			.split('\n')
			.find((candidate) => candidate.trim() !== '')
			?.trim() ?? '';
	if (line.length <= SUMMARY_LENGTH) {
		return line;
	}
	return `${line.slice(0, SUMMARY_LENGTH - 1).trimEnd()}…`;
}

const RISK_ORDER: Record<Action['risk'], number> = {low: 0, medium: 1, high: 2};

/** The tools as actions, the ones that only read first and the high-risk ones last, as every page shows them. */
export function mcpToolActions(tools: McpTool[]): Action[] {
	return tools
		.map((tool, index) => ({tool, index}))
		.sort(
			(a, b) =>
				RISK_ORDER[mcpToolRisk(a.tool)] - RISK_ORDER[mcpToolRisk(b.tool)] || a.index - b.index,
		)
		.map(({tool}) => ({
			id: tool.name,
			label: mcpToolTitle(tool),
			description: summarize(tool.description),
			risk: mcpToolRisk(tool),
			...(tool.annotations?.openWorldHint ? {reachesOthers: true as const} : {}),
		}));
}

/**
 * The integration of a connection: the catalog's, or for a custom MCP server the catalog's entry
 * with the connection's own tools as its actions. Undefined for an integration the catalog no
 * longer has.
 */
export function integrationFor(connection: {
	integrationId: string;
	tools?: McpTool[] | null;
}): Integration | undefined {
	const integration = findIntegration(connection.integrationId);
	if (!integration?.custom) {
		return integration;
	}
	const tools = connection.tools ?? [];
	return {...integration, actions: mcpToolActions(tools), mcpTools: tools};
}
