-- The experiments on for an organization, and insiders, who have all of them; both set from the
-- internal admin.
ALTER TABLE "Organization" ADD COLUMN     "experiments" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "insider" BOOLEAN NOT NULL DEFAULT false;
