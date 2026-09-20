import { Vec3 } from 'vec3';

/** Euclidean distance between two Vec3-like objects */
export function distance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

/** Horizontal (XZ) distance only */
export function horizontalDistance(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): number {
    return Math.sqrt((a.x - b.x) ** 2 + (a.z - b.z) ** 2);
}

/** Clamp a number between min and max */
export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

/** Sleep for ms milliseconds */
export function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/** Generate a simple unique ID */
export function generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
}
