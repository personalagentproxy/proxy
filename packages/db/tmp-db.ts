import {PrismaClient} from '@prisma/client';
const db = new PrismaClient();
await db.$executeRawUnsafe(`DROP DATABASE IF EXISTS proxy_merge_check`);
await db.$executeRawUnsafe(`CREATE DATABASE proxy_merge_check`);
await db.$disconnect();
