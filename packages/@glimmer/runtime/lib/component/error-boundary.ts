import { consumeTag, dirtyTag, dirtyTagFor, tagFor } from '@glimmer/validator';

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
    // Use dirtyTag with disableConsumptionAssertion=true because setError
    // is called from an error boundary catch handler, where the tag was
    // already consumed during the (failed) render. This backflow is
    // intentional for error boundary recovery.
    dirtyTag(tagFor(this, '_error'), true);
    this._hasError = true;
    dirtyTag(tagFor(this, '_hasError'), true);
  }

  retry = () => {
    this._error = null;
    dirtyTagFor(this, '_error');
    this._hasError = false;
    dirtyTagFor(this, '_hasError');
  };
}
