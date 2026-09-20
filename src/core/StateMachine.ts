import { BotState } from '../types/enums';
import { EventBus } from './EventBus';
import { logger } from '../utils/logger';

/** Valid state transitions map */
const VALID_TRANSITIONS: Record<BotState, BotState[]> = {
    [BotState.BOOTING]: [BotState.CONNECTING, BotState.DISCONNECTED],
    [BotState.CONNECTING]: [BotState.IDLE, BotState.DISCONNECTED, BotState.RECOVERING],
    [BotState.IDLE]: [BotState.EXECUTING_TASK, BotState.EMERGENCY_OVERRIDE, BotState.DISCONNECTED, BotState.WAITING_CONFIRMATION],
    [BotState.EXECUTING_TASK]: [BotState.IDLE, BotState.EMERGENCY_OVERRIDE, BotState.DISCONNECTED, BotState.WAITING_CONFIRMATION],
    [BotState.WAITING_CONFIRMATION]: [BotState.EXECUTING_TASK, BotState.IDLE, BotState.EMERGENCY_OVERRIDE, BotState.DISCONNECTED],
    [BotState.EMERGENCY_OVERRIDE]: [BotState.IDLE, BotState.RECOVERING, BotState.DISCONNECTED, BotState.EXECUTING_TASK],
    [BotState.RECOVERING]: [BotState.IDLE, BotState.CONNECTING, BotState.DISCONNECTED, BotState.EMERGENCY_OVERRIDE],
    [BotState.DISCONNECTED]: [BotState.CONNECTING, BotState.BOOTING],
};

export class StateMachine {
    private state: BotState = BotState.BOOTING;

    constructor(private eventBus: EventBus) { }

    getState(): BotState {
        return this.state;
    }

    /**
     * Transition to a new state. Emergency state always overrides.
     * Returns true if transition was valid.
     */
    transition(newState: BotState): boolean {
        // Emergency override is always valid
        if (newState === BotState.EMERGENCY_OVERRIDE) {
            const from = this.state;
            this.state = newState;
            logger.warn('StateMachine', `EMERGENCY OVERRIDE: ${from} → ${newState}`);
            this.eventBus.emit('state:change', { from, to: newState });
            return true;
        }

        // Disconnected is always valid (can happen from any state)
        if (newState === BotState.DISCONNECTED) {
            const from = this.state;
            this.state = newState;
            logger.info('StateMachine', `${from} → ${newState}`);
            this.eventBus.emit('state:change', { from, to: newState });
            return true;
        }

        const allowed = VALID_TRANSITIONS[this.state];
        if (!allowed || !allowed.includes(newState)) {
            logger.warn('StateMachine', `Invalid transition: ${this.state} → ${newState}`);
            return false;
        }

        const from = this.state;
        this.state = newState;
        logger.info('StateMachine', `${from} → ${newState}`);
        this.eventBus.emit('state:change', { from, to: newState });
        return true;
    }

    is(state: BotState): boolean {
        return this.state === state;
    }

    isAny(...states: BotState[]): boolean {
        return states.includes(this.state);
    }
}
