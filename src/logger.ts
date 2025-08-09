import pino from "pino";
import { LOG_LEVEL } from "./config";

export const logger = pino({
  level: LOG_LEVEL,
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,
});

export function createLogger(bindings: Record<string, any>) {
  return logger.child(bindings);
}