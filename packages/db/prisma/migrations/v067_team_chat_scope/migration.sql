-- Shared persona configuration is not permission to publish existing member histories.
CREATE TYPE "ConversationScope" AS ENUM ('member', 'team');
ALTER TABLE "Persona"
  ADD COLUMN "conversationScope" "ConversationScope" NOT NULL DEFAULT 'member',
  ADD COLUMN "headAgent" BOOLEAN NOT NULL DEFAULT false;

-- A team conversation is organization-visible. Its audience cannot be changed by editing it.
ALTER TABLE "Persona" ADD CONSTRAINT "Persona_team_scope_owner_check"
  CHECK ("conversationScope" <> 'team' OR "ownerUserId" IS NULL);

CREATE FUNCTION prevent_persona_scope_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."conversationScope" IS DISTINCT FROM OLD."conversationScope" THEN
    RAISE EXCEPTION 'Conversation scope is immutable; create a new conversation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "Persona_immutable_conversation_scope"
  BEFORE UPDATE OF "conversationScope" ON "Persona"
  FOR EACH ROW EXECUTE FUNCTION prevent_persona_scope_change();

-- Keep historical messages untouched. New messages will carry the authenticated sender.
ALTER TABLE "AgentEntry"
  ADD COLUMN "senderUserId" TEXT,
  ADD COLUMN "senderName" TEXT;

ALTER TABLE "AgentThread" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AgentThread" ADD COLUMN "teamChat" BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX "AgentThread_personaId_teamChat_idx" ON "AgentThread" ("personaId", "teamChat");
ALTER TABLE "AgentAlert" ALTER COLUMN "userId" DROP NOT NULL;
ALTER TABLE "AgentThread" ADD CONSTRAINT "AgentThread_team_identity_check"
  CHECK (NOT "teamChat" OR "userId" IS NULL);
