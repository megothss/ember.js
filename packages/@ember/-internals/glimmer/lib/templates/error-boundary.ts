import { precompileTemplate } from '@ember/template-compilation';
export default precompileTemplate(
  `{{#if this.hasError}}{{yield this.error this.retry to="error"}}{{else}}{{yield}}{{/if}}`,
  {
    moduleName: 'packages/@ember/-internals/glimmer/lib/templates/error-boundary.hbs',
    strictMode: true,
    scope() {
      return {};
    },
  }
);
