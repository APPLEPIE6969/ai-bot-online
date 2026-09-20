import { Task } from '../types/interfaces';
import { TaskPriority, BotState } from '../types/enums';
import { EventBus } from './EventBus';
import { StateMachine } from './StateMachine';
import { logger } from '../utils/logger';
import { generateId } from '../utils/math';

/**
 * Priority-based task engine.
 * Higher priority tasks interrupt lower priority tasks.
 * Enforces timeouts, retry limits, and logs all transitions.
 */
export class TaskEngine {
    private queue: Task[] = [];
    private currentTask: Task | null = null;
    private isProcessing = false;
    private taskTimeout: NodeJS.Timeout | null = null;

    constructor(
        private eventBus: EventBus,
        private stateMachine: StateMachine
    ) { }

    /**
     * Submit a new task to the engine.
     * If its priority is higher than the current task, it will interrupt.
     */
    async submit(task: Task): Promise<void> {
        logger.info('TaskEngine', `Task submitted: "${task.name}" [${TaskPriority[task.priority]}]`);

        // If a higher priority task is already running, queue this one
        if (this.currentTask && task.priority <= this.currentTask.priority) {
            this.insertSorted(task);
            logger.info('TaskEngine', `Queued behind "${this.currentTask.name}" (${this.queue.length} in queue)`);
            return;
        }

        // If current task is lower priority, interrupt it
        if (this.currentTask && task.priority > this.currentTask.priority) {
            logger.warn('TaskEngine', `Interrupting "${this.currentTask.name}" for higher priority "${task.name}"`);
            await this.cancelCurrent(`Interrupted by higher priority: ${task.name}`);
        }

        // Execute immediately
        await this.execute(task);
    }

    /**
     * Cancel the currently running task.
     */
    async cancelCurrent(reason: string = 'Cancelled'): Promise<void> {
        if (!this.currentTask) return;
        const task = this.currentTask;
        logger.info('TaskEngine', `Cancelling: "${task.name}" — ${reason}`);
        this.clearTimeout();
        try {
            await task.cancel();
        } catch (e) {
            logger.error('TaskEngine', `Error cancelling "${task.name}": ${e instanceof Error ? e.message : String(e)}`);
        }
        this.eventBus.emit('task:cancel', { taskId: task.id, reason });
        this.currentTask = null;
    }

    /**
     * Cancel all tasks (current + queued).
     */
    async cancelAll(reason: string = 'All tasks cancelled'): Promise<void> {
        await this.cancelCurrent(reason);
        this.queue = [];
    }

    /**
     * Get the current task name (for UI/debug).
     */
    getCurrentTaskName(): string | null {
        return this.currentTask?.name ?? null;
    }

    getQueueLength(): number {
        return this.queue.length;
    }

    // ─── Internal ───────────────────────────────────────

    private async execute(task: Task): Promise<void> {
        this.currentTask = task;
        this.isProcessing = true;
        this.stateMachine.transition(BotState.EXECUTING_TASK);
        this.eventBus.emit('task:start', { taskId: task.id, name: task.name });

        // Set timeout
        if (task.timeoutMs > 0) {
            this.taskTimeout = setTimeout(async () => {
                logger.warn('TaskEngine', `Task "${task.name}" timed out after ${task.timeoutMs}ms`);
                if (task.onTimeout) {
                    try { await task.onTimeout(); } catch (_) { }
                }
                await this.cancelCurrent('Timed out');
                this.processNext();
            }, task.timeoutMs);
        }

        try {
            await task.execute();
            this.clearTimeout();
            logger.info('TaskEngine', `Task complete: "${task.name}"`);
            this.eventBus.emit('task:complete', { taskId: task.id, name: task.name, success: true });
        } catch (e) {
            this.clearTimeout();
            const errMsg = e instanceof Error ? e.message : String(e);
            logger.error('TaskEngine', `Task "${task.name}" failed: ${errMsg}`);

            // Retry logic
            if (task.retries < task.maxRetries) {
                task.retries++;
                logger.info('TaskEngine', `Retrying "${task.name}" (${task.retries}/${task.maxRetries})...`);
                this.currentTask = null;
                await this.execute(task);
                return;
            }

            this.eventBus.emit('task:complete', { taskId: task.id, name: task.name, success: false });
        }

        this.currentTask = null;
        this.isProcessing = false;
        this.processNext();
    }

    private processNext(): void {
        if (this.queue.length === 0) {
            this.stateMachine.transition(BotState.IDLE);
            return;
        }
        const next = this.queue.shift()!;
        this.execute(next);
    }

    private insertSorted(task: Task): void {
        // Insert in descending priority order (highest first)
        let i = 0;
        while (i < this.queue.length && this.queue[i].priority >= task.priority) {
            i++;
        }
        this.queue.splice(i, 0, task);
    }

    private clearTimeout(): void {
        if (this.taskTimeout) {
            clearTimeout(this.taskTimeout);
            this.taskTimeout = null;
        }
    }
}
