import { logger } from '../utils/logger';

type EventHandler = (...args: any[]) => void;

/**
 * Typed publish/subscribe event bus for decoupled module communication.
 */
export class EventBus {
    private handlers: Map<string, EventHandler[]> = new Map();

    on(event: string, handler: EventHandler): void {
        if (!this.handlers.has(event)) {
            this.handlers.set(event, []);
        }
        this.handlers.get(event)!.push(handler);
    }

    off(event: string, handler: EventHandler): void {
        const list = this.handlers.get(event);
        if (!list) return;
        const idx = list.indexOf(handler);
        if (idx !== -1) list.splice(idx, 1);
    }

    emit(event: string, ...args: any[]): void {
        const list = this.handlers.get(event);
        if (!list || list.length === 0) return;
        for (const handler of list) {
            try {
                handler(...args);
            } catch (e) {
                logger.error('EventBus', `Handler error for '${event}': ${e instanceof Error ? e.message : String(e)}`);
            }
        }
    }

    once(event: string, handler: EventHandler): void {
        const wrapper = (...args: any[]) => {
            this.off(event, wrapper);
            handler(...args);
        };
        this.on(event, wrapper);
    }

    removeAllListeners(event?: string): void {
        if (event) {
            this.handlers.delete(event);
        } else {
            this.handlers.clear();
        }
    }
}
