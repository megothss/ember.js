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
import { createConstRef } from '@glimmer/reference';
import { ErrorBoundaryState } from '@glimmer/runtime';

import ErrorBoundaryTemplate from '../templates/error-boundary';

const CAPABILITIES: InternalComponentCapabilities = {
  dynamicLayout: false,
  dynamicTag: false,
  prepareArgs: false,
  createArgs: false,
  attributeHook: false,
  elementHook: false,
  createCaller: false,
  dynamicScope: false,
  updateHook: false,
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
    _args: Nullable<VMArguments>,
    _env: Environment,
    _dynamicScope: Nullable<DynamicScope>,
    _caller: Nullable<Reference>,
    _hasDefaultBlock: boolean
  ): ErrorBoundaryState {
    return new ErrorBoundaryState();
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

  update(_instance: ErrorBoundaryState, _dynamicScope: Nullable<DynamicScope>): void {}

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
