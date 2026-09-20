import { logger } from './logger';

/**
 * Wraps an async function with a timeout.
 * Rejects with an error if the function doesn't resolve within `ms`.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string = 'operation'): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(`[Timeout] ${label} timed out after ${ms}ms`)), ms);
    });
    try {
        const result = await Promise.race([promise, timeoutPromise]);
        clearTimeout(timeoutId!);
        return result;
    } catch (e) {
        clearTimeout(timeoutId!);
        throw e;
    }
}

/**
 * Retry an async function up to `maxRetries` times with a delay between attempts.
 */
export async function withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number,
    delayMs: number = 1000,
    label: string = 'operation'
): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (e) {
            lastError = e instanceof Error ? e : new Error(String(e));
            if (attempt < maxRetries) {
                logger.warn('Safety', `${label} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${lastError.message}. Retrying in ${delayMs}ms...`);
                await new Promise(r => setTimeout(r, delayMs));
            }
        }
    }
    throw lastError ?? new Error(`${label} failed after ${maxRetries + 1} attempts`);
}

/**
 * Simple async mutex to prevent concurrent access.
 */
export class AsyncLock {
    private locked = false;
    private queue: (() => void)[] = [];

    async acquire(): Promise<void> {
        if (!this.locked) {
            this.locked = true;
            return;
        }
        return new Promise<void>(resolve => {
            this.queue.push(resolve);
        });
    }

    release(): void {
        if (this.queue.length > 0) {
            const next = this.queue.shift()!;
            next();
        } else {
            this.locked = false;
        }
    }
}
