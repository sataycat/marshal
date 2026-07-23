import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/repository-schema.ts",
  out: "./src/storage/migrations/repository",
  dbCredentials: { url: "./state.db" },
});
