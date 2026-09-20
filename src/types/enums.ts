// ─── Operation Modes ────────────────────────────────────────────
export enum Mode {
    FULL_AUTO = 'FULL_AUTO',
    HALF_AUTO = 'HALF_AUTO',
    PASSIVE = 'PASSIVE',
}

// ─── Bot State Machine ──────────────────────────────────────────
export enum BotState {
    BOOTING = 'BOOTING',
    CONNECTING = 'CONNECTING',
    IDLE = 'IDLE',
    EXECUTING_TASK = 'EXECUTING_TASK',
    WAITING_CONFIRMATION = 'WAITING_CONFIRMATION',
    EMERGENCY_OVERRIDE = 'EMERGENCY_OVERRIDE',
    RECOVERING = 'RECOVERING',
    DISCONNECTED = 'DISCONNECTED',
}

// ─── Task Priority ──────────────────────────────────────────────
export enum TaskPriority {
    EMERGENCY = 100,
    SURVIVAL = 90,
    PLAYER = 80,
    AUTONOMOUS = 60,
    BACKGROUND = 40,
    IDLE = 10,
}

// ─── Task Category ──────────────────────────────────────────────
export enum TaskCategory {
    EMERGENCY = 'EMERGENCY',
    SURVIVAL = 'SURVIVAL',
    BUILD = 'BUILD',
    FARM = 'FARM',
    MINE = 'MINE',
    EXPLORE = 'EXPLORE',
    STORAGE = 'STORAGE',
    PLAYER_COMMAND = 'PLAYER_COMMAND',
}

// ─── Stash Type ─────────────────────────────────────────────────
export enum StashType {
    MAIN_STORAGE = 'MAIN_STORAGE',
    SECRET_STORAGE = 'SECRET_STORAGE',
    TEMP_STORAGE = 'TEMP_STORAGE',
    FOOD_STORAGE = 'FOOD_STORAGE',
    RARE_ITEMS = 'RARE_ITEMS',
    ORE_STORAGE = 'ORE_STORAGE',
}

// ─── Log Level ──────────────────────────────────────────────────
export enum LogLevel {
    DEBUG = 'DEBUG',
    INFO = 'INFO',
    WARN = 'WARN',
    ERROR = 'ERROR',
}
