import { precompileTemplate } from '@ember/template-compilation';

/**
 * Experiment: `<ErrorBoundary>` as thin sugar over `{{#try}}`, to measure what
 * being a component costs on top of the keyword. Supports only the
 * `<:try>`/`<:catch>` form.
 */
export default precompileTemplate(
  `{{#try}}{{yield to="try"}}{{catch as |error retry|}}{{yield error retry to="catch"}}{{/try}}`,
  {
    moduleName: 'packages/@ember/-internals/glimmer/lib/templates/error-boundary.hbs',
    strictMode: true,
    scope() {
      return {};
    },
  }
);
