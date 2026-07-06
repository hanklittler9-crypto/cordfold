import { defineConfig } from '@prisma/config';

export default defineConfig({
  datasource: {
    url: process.env.DATABASE_URL ?? '',
    // directUrl removed; not supported in Prisma 7+ config
  },
});
