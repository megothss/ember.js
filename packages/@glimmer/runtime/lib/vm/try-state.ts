import type { Tag, UpdatableTag } from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference/lib/reference';
import type { Revision } from '@glimmer/validator/lib/validators';
import { createComputeRef, createConstRef } from '@glimmer/reference/lib/reference';
import { consumeTag } from '@glimmer/validator/lib/tracking';
import {
  CONSTANT_TAG,
  createUpdatableTag,
  DIRTY_TAG,
  validateTag,
  valueForTag,
} from '@glimmer/validator/lib/validators';

/**
 * The state behind one `{{#try}}`: whether its body failed, with what error,
 * and which tracked state the failed attempt read, so it can retry
 * automatically when any of that changes.
 */
export class TryState {
  readonly errorRef: Reference;
  readonly retryRef: Reference;
  readonly hasErrorRef: Reference;

  #error: unknown = null;
  #hasError = false;
  readonly #errorTag: UpdatableTag = createUpdatableTag();
  readonly #hasErrorTag: UpdatableTag = createUpdatableTag();

  /** Everything the failed attempt consumed before it threw. */
  #failedTag: Tag = CONSTANT_TAG;

  /** Revision of `#failedTag` when the error was caught. */
  #failedRevision: Revision = 0;

  constructor() {
    this.errorRef = createComputeRef(() => this.error, null, 'try:error');
    this.retryRef = createConstRef(this.retry, 'try:retry');
    this.hasErrorRef = createComputeRef(() => this.hasError, null, 'try:hasError');
  }

  get error(): unknown {
    consumeTag(this.#errorTag);
    return this.#error;
  }

  get hasError(): boolean {
    consumeTag(this.#hasErrorTag);
    return this.#hasError;
  }

  /**
   * Records a caught error. The failed attempt already consumed these tags in
   * the same render, so dirtying them skips the backtracking assertion.
   */
  setError(error: unknown, failedTag: Tag): void {
    this.#error = error;
    this.#hasError = true;
    DIRTY_TAG(this.#errorTag, true);
    DIRTY_TAG(this.#hasErrorTag, true);

    // Snapshot after dirtying: the failed attempt read `hasError` itself, and
    // that change must not count as a reason to retry.
    this.#failedTag = failedTag;
    this.#failedRevision = valueForTag(failedTag);
  }

  /**
   * Consumes what the enclosing cache group must revalidate on: the error
   * state itself and, while failed, everything the failed attempt read.
   */
  consumeTags(): void {
    consumeTag(this.#hasErrorTag);

    if (this.#hasError) {
      consumeTag(this.#failedTag);
    }
  }

  /**
   * True when failed and state read by the failed attempt has changed since.
   * Clears the error so the caller can render the body again.
   */
  shouldRetry(): boolean {
    if (!this.#hasError || validateTag(this.#failedTag, this.#failedRevision)) {
      return false;
    }

    this.#clear(true);
    return true;
  }

  retry = (): void => {
    this.#clear(false);
  };

  #clear(duringRender: boolean): void {
    this.#error = null;
    this.#hasError = false;
    this.#failedTag = CONSTANT_TAG;
    DIRTY_TAG(this.#errorTag, duringRender);
    DIRTY_TAG(this.#hasErrorTag, duringRender);
  }
}
