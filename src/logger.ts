import pino from "pino";

export const logger = pino(
  {
    name: "marshal",
    level: process.env.LOG_LEVEL ?? "info",
  },
  pino.destination(process.stderr),
);

export function getLogger() {
  return logger;
}
