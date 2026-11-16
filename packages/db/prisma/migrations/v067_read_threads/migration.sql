-- Each thread is read on its own, as the member opens it, rather than the chat across its threads:
-- every thread starts read as far as its chat was, and the chat keeps 0.
UPDATE "AgentThread" AS t SET "readSeq" = c."readSeq"
FROM "AgentThread" AS c
WHERE t."parentThreadId" = c."id";

UPDATE "AgentThread" SET "readSeq" = 0 WHERE "parentThreadId" IS NULL;
