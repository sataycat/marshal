import pino from "pino";

export const logger = pino({
  name: "marshal",
  level: process.env.LOG_LEVEL ?? "info",
});

export function getLogger() {
  return logger;
}
