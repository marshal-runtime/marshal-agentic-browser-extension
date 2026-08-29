/**
 * Structured JSON logger with configurable log levels and request ID correlation.
 *
 * Wraps `console.debug`, `console.warn`, and `console.error` to produce
 * structured JSON output.  Never calls `console.log` or `console.info`.
 */

/** Log severity levels ordered from most to least verbose. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Structured log entry emitted by the logger. */
interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  requestId?: string;
  context?: Record<string, unknown>;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/**
 * Structured logger that outputs JSON entries via console methods.
 *
 * Uses a singleton pattern — obtain the shared instance via {@link Logger.getInstance}.
 */
class Logger {
  private static instance: Logger | undefined;

  private level: LogLevel;
  private requestId: string | undefined;

  private constructor(level: LogLevel) {
    this.level = level;
  }

  /** Returns the singleton logger instance. */
  static getInstance(): Logger {
    if (!Logger.instance) {
      Logger.instance = new Logger('info');
    }
    return Logger.instance;
  }

  /** Sets the minimum log level. Messages below this severity are suppressed. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Returns the current minimum log level. */
  getLevel(): LogLevel {
    return this.level;
  }

  /** Associates a request ID with all subsequent log entries. */
  setRequestId(id: string): void {
    this.requestId = id;
  }

  /** Returns the current request ID, if any. */
  getRequestId(): string | undefined {
    return this.requestId;
  }

  /** Clears the current request ID. */
  clearRequestId(): void {
    this.requestId = undefined;
  }

  /** Logs a debug-level message. */
  debug(message: string, context?: Record<string, unknown>): void {
    this.emit('debug', message, context);
  }

  /** Logs an info-level message. */
  info(message: string, context?: Record<string, unknown>): void {
    this.emit('info', message, context);
  }

  /** Logs a warn-level message. */
  warn(message: string, context?: Record<string, unknown>): void {
    this.emit('warn', message, context);
  }

  /** Logs an error-level message. */
  error(message: string, context?: Record<string, unknown>): void {
    this.emit('error', message, context);
  }

  private emit(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.level]) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    if (this.requestId) {
      entry.requestId = this.requestId;
    }

    if (context) {
      entry.context = context;
    }

    const serialized = JSON.stringify(entry);

    switch (level) {
      case 'debug':
      case 'info':
        // console.info is banned by ESLint; route info through console.debug
        console.debug(serialized);
        break;
      case 'warn':
        console.warn(serialized);
        break;
      case 'error':
        console.error(serialized);
        break;
    }
  }
}

/** Singleton logger instance. */
const logger = Logger.getInstance();

export { Logger, logger };
export type { LogLevel, LogEntry };
