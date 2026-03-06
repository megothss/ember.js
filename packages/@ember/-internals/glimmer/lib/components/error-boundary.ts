import type {
  Bounds,
  Destroyable,
  DynamicScope,
  Environment,
  InternalComponentCapabilities,
  InternalComponentManager,
  Nullable,
  Owner,
  VMArguments,
  WithCreateInstance,
} from '@glimmer/interfaces';
import type { Reference } from '@glimmer/reference';
import { setComponentTemplate, setInternalComponentManager } from '@glimmer/manager';
import { createConstRef, valueForRef } from '@glimmer/reference';
import { ErrorBoundaryState } from '@glimmer/runtime';

import ErrorBoundaryTemplate from '../templates/error-boundary';

const CAPABILITIES: InternalComponentCapabilities = {
  dynamicLayout: false,
  dynamicTag: false,
  prepareArgs: false,
  createArgs: true,
  attributeHook: false,
  elementHook: false,
  createCaller: false,
  dynamicScope: false,
  updateHook: true,
  createInstance: true,
  wrapped: false,
  willDestroy: false,
  hasSubOwner: false,
  errorBoundary: true,
};

class ErrorBoundaryManager
  implements InternalComponentManager<ErrorBoundaryState>, WithCreateInstance<ErrorBoundaryState>
{
  getCapabilities(): InternalComponentCapabilities {
    return CAPABILITIES;
  }

  create(
    _owner: Owner,
    _definition: object,
    args: Nullable<VMArguments>,
    _env: Environment,
    _dynamicScope: Nullable<DynamicScope>,
    _caller: Nullable<Reference>,
    _hasDefaultBlock: boolean
  ): ErrorBoundaryState {
    let state = new ErrorBoundaryState();

    if (args && args.named.has('retryWith')) {
      let retryWithRef = args.named.get('retryWith');
      state.retryWithRef = retryWithRef;
      state._lastRetryWithValue = valueForRef(retryWithRef);
    }

    return state;
  }

  didCreate(): void {}
  didUpdate(): void {}
  didRenderLayout(): void {}
  didUpdateLayout(): void {}

  getDebugName(): string {
    return 'ErrorBoundary';
  }

  getSelf(instance: ErrorBoundaryState): Reference {
    return createConstRef(instance, 'this');
  }

  getDestroyable(_instance: ErrorBoundaryState): Nullable<Destroyable> {
    return null;
  }

  update(instance: ErrorBoundaryState, _dynamicScope: Nullable<DynamicScope>): void {
    // Consume the @retryWith ref's tag at the ROOT tracking level (outside
    // the EB component's JumpIfNotModified scope). This ensures the root's
    // combined tag includes the retryWith value, so root JumpIfNotModified
    // falls through when @retryWith changes — which in turn allows the EB's
    // opcodes to run.
    // The actual reset logic is in ErrorBoundaryOpcode.evaluate().
    if (instance.retryWithRef) {
      valueForRef(instance.retryWithRef);
    }
  }

  didSplatAttributes(
    _instance: ErrorBoundaryState,
    _element: ErrorBoundaryState,
    _operations: Bounds
  ): void {}
}

const MANAGER = new ErrorBoundaryManager();

const ErrorBoundary = {
  create() {
    throw new Error('ErrorBoundary does not support .create(). It is managed internally.');
  },
};
setInternalComponentManager(MANAGER, ErrorBoundary);
setComponentTemplate(ErrorBoundaryTemplate, ErrorBoundary);

export default ErrorBoundary;
