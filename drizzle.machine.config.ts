import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/storage/machine-schema.ts",
  out: "./src/storage/migrations/machine",
  dbCredentials: { url: "./machine.db" },
});
