-- Requests made by code in a sandbox, calling `/api/cli` with the token its command was given,
-- come in a fourth way, `cli`, beside the agent pages, the MCP server and the built-in agent.

-- AlterEnum
ALTER TYPE "AuditVia" ADD VALUE IF NOT EXISTS 'cli';
