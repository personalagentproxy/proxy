-- Installation-wide values used by the anonymous daily telemetry heartbeat.
CREATE TABLE "InstanceMeta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InstanceMeta_pkey" PRIMARY KEY ("key")
);
