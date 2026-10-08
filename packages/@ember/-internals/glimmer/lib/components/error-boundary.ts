import { setComponentTemplate } from '@glimmer/manager/lib/public/template';
import { templateOnlyComponent } from '@glimmer/runtime/lib/component/template-only';

import ErrorBoundaryTemplate from '../templates/error-boundary';

/**
 * Experiment: a template-only `<ErrorBoundary>` whose layout is a single
 * `{{#try}}`. Template-only is the cheapest component form, so the remaining
 * gap to the keyword is the floor cost of being a component.
 */
const ErrorBoundary = setComponentTemplate(
  ErrorBoundaryTemplate,
  templateOnlyComponent(
    'packages/@ember/-internals/glimmer/lib/components/error-boundary',
    'ErrorBoundary'
  )
);

export default ErrorBoundary;
