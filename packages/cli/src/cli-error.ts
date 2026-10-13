/**
 * What went wrong, in words for whoever ran the command, and the exit code it ends with: 2 for a
 * command used wrongly, 1 for anything else, such as a refusal from the server.
 */
export type CliError = {message: string; exitCode: 1 | 2};

export const CliErr = {
	usage: (message: string): CliError => ({message, exitCode: 2}),
	failed: (message: string): CliError => ({message, exitCode: 1}),
};
