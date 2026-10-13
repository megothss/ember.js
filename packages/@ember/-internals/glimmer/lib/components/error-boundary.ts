import { setComponentTemplate } from '@glimmer/manager/lib/public/template';
import { templateOnlyComponent } from '@glimmer/runtime/lib/component/template-only';

import ErrorBoundaryTemplate from '../templates/error-boundary';

/**
 * A template-only `<ErrorBoundary>` whose layout is a single `{{#try}}`. Its
 * `<:try>` and `<:catch>` are named blocks, so unlike the keyword's clauses
 * they can be written in either order.
 */
const ErrorBoundary = setComponentTemplate(
  ErrorBoundaryTemplate,
  templateOnlyComponent(
    'packages/@ember/-internals/glimmer/lib/components/error-boundary',
    'ErrorBoundary'
  )
);

export default ErrorBoundary;
