import type { Reference } from '@glimmer/reference';
import type { UpdatableTag } from '@glimmer/validator';
import { valueForRef } from '@glimmer/reference';
import { consumeTag, dirtyTag, dirtyTagFor, tagFor } from '@glimmer/validator';

export interface ErrorBoundaryState {
  error: unknown;
  hasError: boolean;
  setError(error: unknown): void;
  retry(): void;
  initRetryWith(ref: Reference, initialValue: unknown): void;
  consumeRetryWith(): void;
  checkRetryWith(): boolean;
}

/**
 * Shallow-compare two values. Supports primitives (===), arrays (element-wise),
 * and plain objects (own-property value-wise).
 */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // After the === check above, at most one side is null/undefined.
  // Treat null and undefined as distinct (null !== undefined).
  if (a == null || b == null) return false;

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  if (typeof a === 'object' && typeof b === 'object') {
    let keysA = Object.keys(a);
    let keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (let key of keysA) {
      if ((a as Record<string, unknown>)[key] !== (b as Record<string, unknown>)[key]) {
        return false;
      }
    }
    return true;
  }

  return false;
}

/**
 * Snapshot a value for later comparison. Clones arrays and plain objects
 * to prevent reference aliasing.
 */
function snapshot(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice();
  if (value !== null && typeof value === 'object') return { ...value };
  return value;
}

export class ErrorBoundaryStateImpl implements ErrorBoundaryState {
  private _error: unknown = null;
  private _hasError = false;

  // @retryWith support: tracks a reference whose value, when changed,
  // automatically clears the error state and retries the default block.
  private retryWithRef: Reference | null = null;
  private lastRetryWithValue: unknown = undefined;

  get error(): unknown {
    consumeTag(tagFor(this, '_error'));
    return this._error;
  }

  get hasError(): boolean {
    consumeTag(tagFor(this, '_hasError'));
    return this._hasError;
  }

  setError(error: unknown) {
    this._error = error;
    // Use dirtyTag with disableConsumptionAssertion=true because setError
    // is called from an error boundary catch handler, where the tag was
    // already consumed during the (failed) render. This backflow is
    // intentional for error boundary recovery.
    dirtyTag(tagFor(this, '_error') as UpdatableTag, true);
    this._hasError = true;
    dirtyTag(tagFor(this, '_hasError') as UpdatableTag, true);
  }

  retry = () => {
    this._error = null;
    dirtyTagFor(this, '_error');
    this._hasError = false;
    dirtyTagFor(this, '_hasError');
  };

  initRetryWith(ref: Reference, initialValue: unknown) {
    this.retryWithRef = ref;
    this.lastRetryWithValue = snapshot(initialValue);
  }

  consumeRetryWith() {
    if (this.retryWithRef) {
      valueForRef(this.retryWithRef);
    }
  }

  /**
   * Check if the @retryWith value has changed. If it has and the boundary
   * is in error state, clear the error state and return true so the caller
   * (ErrorBoundaryOpcode.evaluate()) can re-render via handleException().
   *
   * Also consumes the retryWith ref's tag (via valueForRef), keeping it in
   * the current tracking frame. This ensures the EB component's
   * JumpIfNotModified detects future @retryWith changes.
   */
  checkRetryWith(): boolean {
    if (this.retryWithRef === null) return false;

    let current = valueForRef(this.retryWithRef);

    if (!shallowEqual(current, this.lastRetryWithValue)) {
      this.lastRetryWithValue = snapshot(current);

      if (this._hasError) {
        this._error = null;
        // Dirty with disableConsumptionAssertion=true because we may be
        // inside a tracking frame that already consumed these tags.
        dirtyTag(tagFor(this, '_error') as UpdatableTag, true);
        this._hasError = false;
        dirtyTag(tagFor(this, '_hasError') as UpdatableTag, true);
        return true;
      }
    }

    return false;
  }
}
