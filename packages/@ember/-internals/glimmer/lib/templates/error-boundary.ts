import { precompileTemplate } from '@ember/template-compilation';
export default precompileTemplate(
  `{{#if this.hasError}}{{yield this.error this.retry to="catch"}}{{else if (has-block "try")}}{{yield to="try"}}{{else}}{{yield}}{{/if}}`,
  {
    moduleName: 'packages/@ember/-internals/glimmer/lib/templates/error-boundary.hbs',
    strictMode: true,
    scope() {
      return {};
    },
  }
);
