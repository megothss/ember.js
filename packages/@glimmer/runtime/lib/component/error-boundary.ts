import type { Tag, UpdatableTag } from '@glimmer/interfaces';
import type { Revision } from '@glimmer/validator/lib/validators';
import {
  CONSTANT_TAG,
  DIRTY_TAG as dirtyTag,
  validateTag,
  valueForTag,
} from '@glimmer/validator/lib/validators';
import { consumeTag } from '@glimmer/validator/lib/tracking';
import { dirtyTagFor, tagFor } from '@glimmer/validator/lib/meta';

export interface ErrorBoundaryState {
  error: unknown;
  hasError: boolean;
  setError(error: unknown, failedTag?: Tag): void;
  retry(): void;
  consumeFailedTag(): void;
  shouldRetry(): boolean;
}

export class ErrorBoundaryStateImpl implements ErrorBoundaryState {
  private _error: unknown = null;
  private _hasError = false;

  /**
   * Everything the failed render consumed before it threw. When any of it
   * changes, the render might succeed now, so the boundary retries.
   */
  private failedTag: Tag = CONSTANT_TAG;

  /** Revision of `failedTag` when the error was caught. */
  private failedRevision: Revision = 0;

  get error(): unknown {
    consumeTag(tagFor(this, '_error'));
    return this._error;
  }

  get hasError(): boolean {
    consumeTag(tagFor(this, '_hasError'));
    return this._hasError;
  }

  setError(error: unknown, failedTag: Tag = CONSTANT_TAG) {
    this._error = error;
    // Use dirtyTag with disableConsumptionAssertion=true because setError
    // is called from an error boundary catch handler, where the tag was
    // already consumed during the (failed) render. This backflow is
    // intentional for error boundary recovery.
    dirtyTag(tagFor(this, '_error') as UpdatableTag, true);
    this._hasError = true;
    dirtyTag(tagFor(this, '_hasError') as UpdatableTag, true);

    // Snapshot after dirtying: the failed render read `hasError` itself, and
    // that change must not count as a reason to retry.
    this.failedTag = failedTag;
    this.failedRevision = valueForTag(failedTag);
  }

  /**
   * Consume the failed render's tag so the enclosing cache group re-runs the
   * boundary when any state read by the failed render changes.
   */
  consumeFailedTag() {
    if (this._hasError) {
      consumeTag(this.failedTag);
    }
  }

  /**
   * True when the boundary is in error state and state read by the failed
   * render has changed since. Clears the error state so the caller can
   * re-render the default block.
   */
  shouldRetry(): boolean {
    if (!this._hasError || validateTag(this.failedTag, this.failedRevision)) {
      return false;
    }

    this.clearError();
    return true;
  }

  private clearError() {
    this._error = null;
    // Dirty with disableConsumptionAssertion=true because we may be
    // inside a tracking frame that already consumed these tags.
    dirtyTag(tagFor(this, '_error') as UpdatableTag, true);
    this._hasError = false;
    dirtyTag(tagFor(this, '_hasError') as UpdatableTag, true);
    this.failedTag = CONSTANT_TAG;
  }

  retry = () => {
    this._error = null;
    dirtyTagFor(this, '_error');
    this._hasError = false;
    dirtyTagFor(this, '_hasError');
    this.failedTag = CONSTANT_TAG;
  };
}
