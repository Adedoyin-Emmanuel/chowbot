type LogLevel = "info" | "warn" | "error";

const write = (level: LogLevel, message: string, ...details: unknown[]) => {
  console.error(
    `${new Date().toISOString()} [${level.toUpperCase()}] ${message}`,
    ...details,
  );
};

export const logger = {
  info: (message: string, ...details: unknown[]) =>
    write("info", message, ...details),
  warn: (message: string, ...details: unknown[]) =>
    write("warn", message, ...details),
  error: (message: string, ...details: unknown[]) =>
    write("error", message, ...details),
};
