import { precompileTemplate } from '@ember/template-compilation';

/**
 * The whole of `<ErrorBoundary>`: a `{{#try}}` that yields to the `<:try>` and
 * `<:catch>` blocks. A boundary with no fallback uses `{{#try}}` directly, so
 * there is no default-block form.
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
