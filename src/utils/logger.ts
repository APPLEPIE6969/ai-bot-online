import { LogLevel } from '../types/enums';

const COLORS: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: '\x1b[90m',  // gray
    [LogLevel.INFO]: '\x1b[36m',  // cyan
    [LogLevel.WARN]: '\x1b[33m',  // yellow
    [LogLevel.ERROR]: '\x1b[31m',  // red
};
const RESET = '\x1b[0m';

let minLevel: LogLevel = LogLevel.INFO;

const LEVEL_ORDER: Record<LogLevel, number> = {
    [LogLevel.DEBUG]: 0,
    [LogLevel.INFO]: 1,
    [LogLevel.WARN]: 2,
    [LogLevel.ERROR]: 3,
};

function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[minLevel];
}

function formatTime(): string {
    return new Date().toISOString().substring(11, 19);
}

function log(level: LogLevel, tag: string, message: string, ...args: unknown[]): void {
    if (!shouldLog(level)) return;
    const color = COLORS[level];
    const prefix = `${color}[${formatTime()}] [${level}] [${tag}]${RESET}`;
    console.log(prefix, message, ...args);
}

export const logger = {
    debug: (tag: string, msg: string, ...args: unknown[]) => log(LogLevel.DEBUG, tag, msg, ...args),
    info: (tag: string, msg: string, ...args: unknown[]) => log(LogLevel.INFO, tag, msg, ...args),
    warn: (tag: string, msg: string, ...args: unknown[]) => log(LogLevel.WARN, tag, msg, ...args),
    error: (tag: string, msg: string, ...args: unknown[]) => log(LogLevel.ERROR, tag, msg, ...args),
    setLevel: (level: LogLevel) => { minLevel = level; },
};
