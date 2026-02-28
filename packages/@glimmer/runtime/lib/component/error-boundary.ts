import { dirtyTagFor, tagFor } from '@glimmer/validator';
import { consumeTag } from '@glimmer/validator';

export interface ErrorBoundaryStateInterface {
  error: unknown;
  hasError: boolean;
  setError(error: unknown): void;
  retry(): void;
}

export class ErrorBoundaryState implements ErrorBoundaryStateInterface {
  private _error: unknown = null;
  private _hasError = false;

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
    dirtyTagFor(this, '_error');
    this._hasError = true;
    dirtyTagFor(this, '_hasError');
  }

  retry = () => {
    this._error = null;
    dirtyTagFor(this, '_error');
    this._hasError = false;
    dirtyTagFor(this, '_hasError');
  };
}
