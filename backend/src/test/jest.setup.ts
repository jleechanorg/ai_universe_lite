import { logger } from "../lib/logger.js";

export const jestSetup = (): void => {
  // Quiet down pino in tests
  process.env.LOG_LEVEL = "silent";
  logger.level = "silent";
};

export default jestSetup;
