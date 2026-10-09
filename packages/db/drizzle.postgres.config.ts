import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/postgres-schema.ts",
  out: "./src/postgres-migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL ??
      "postgres://beam:beam@127.0.0.1:5432/beam_studio",
  },
});
