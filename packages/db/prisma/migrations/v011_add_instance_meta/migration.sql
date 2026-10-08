-- Values for the whole installation, such as telemetry's random instance id.
CREATE TABLE "InstanceMeta" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,

    CONSTRAINT "InstanceMeta_pkey" PRIMARY KEY ("key")
);
