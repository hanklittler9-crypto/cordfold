import { defineConfig } from '@prisma/config';

export default defineConfig({
  datasource: {
    url: "postgresql://neondb_owner:npg_CdNfem5MFl9p@ep-silent-truth-akl0bn11-pooler.c-3.us-west-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require",
    // directUrl removed; not supported in Prisma 7+ config
  },
});
