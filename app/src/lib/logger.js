import pino from "pino";
import config from "../config.js";
import { createPrettyDestination } from "./log-format.js";

export default function createLogger(options = {}) {
  const level = options.level ?? config.logLevel;
  const pinoOptions = {
    level,
    base: undefined,
    ...options,
  };

  const pretty = !config.isProduction && level !== "silent";
  if (pretty) {
    return pino(pinoOptions, createPrettyDestination());
  }

  return pino(pinoOptions);
}
