import { Mode } from '../types/enums';
import { EventBus } from './EventBus';
import { Database } from '../persistence/Database';
import { logger } from '../utils/logger';

/**
 * Manages FULL_AUTO / HALF_AUTO / PASSIVE modes.
 * Persists mode across restarts via Database.
 */
export class ModeManager {
    private mode: Mode;

    constructor(
        private eventBus: EventBus,
        private database: Database
    ) {
        const config = database.getConfig();
        const state = database.getState();
        this.mode = (state.mode as Mode) || config.mode || Mode.FULL_AUTO;
        logger.info('ModeManager', `Initialized in ${this.mode} mode`);
    }

    getMode(): Mode {
        return this.mode;
    }

    setMode(newMode: Mode): void {
        if (newMode === this.mode) return;
        const from = this.mode;
        this.mode = newMode;
        this.database.saveState({ mode: newMode });
        this.eventBus.emit('mode:change', { from, to: newMode });
        logger.info('ModeManager', `Mode changed: ${from} → ${newMode}`);
    }

    isFullAuto(): boolean {
        return this.mode === Mode.FULL_AUTO;
    }

    isHalfAuto(): boolean {
        return this.mode === Mode.HALF_AUTO;
    }

    isPassive(): boolean {
        return this.mode === Mode.PASSIVE;
    }

    /**
     * Check if a task category requires confirmation in the current mode.
     */
    requiresConfirmation(taskCategory: string): boolean {
        if (this.mode === Mode.FULL_AUTO) return false;
        if (this.mode === Mode.PASSIVE) return true; // Everything requires confirmation

        // HALF_AUTO: only certain categories require confirmation
        const autoAllowed = ['EMERGENCY', 'SURVIVAL'];
        return !autoAllowed.includes(taskCategory);
    }
}
