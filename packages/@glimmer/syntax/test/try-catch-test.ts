import type { ASTv1 } from '@glimmer/syntax';
import {
  builders,
  getTemplateLocals,
  isKeyword,
  normalize,
  preprocess,
  print,
  src,
  traverse,
} from '@glimmer/syntax';

/** Narrow an existing AST node without requiring the new flag in baseline types. */
function blockFor(source: string): ASTv1.BlockStatement & { catch?: boolean } {
  const node = preprocess(source).body[0];
  if (node?.type !== 'BlockStatement') {
    throw new Error('Expected a BlockStatement');
  }
  return node;
}

/** Derive expected source coordinates rather than hard-counting columns. */
function position(source: string, offset: number) {
  const lines = source.slice(0, offset).split('\n');
  return { line: lines.length, column: (lines.at(-1) ?? '').length };
}

/** Build an expected span from offsets into the original template. */
function span(source: string, start: number, end: number) {
  return { start: position(source, start), end: position(source, end) };
}

QUnit.module('[try-catch-syntax] ASTv1 and locations', () => {
  QUnit.test('bare catch marks the block and creates an inverse', (assert) => {
    const block = blockFor('{{#try}}A{{catch}}B{{/try}}');
    assert.true(block.catch);
    assert.true(Object.hasOwn(block, 'catch'));
    assert.deepEqual(
      block.program.body.map((node) => node.type),
      ['TextNode']
    );
    assert.strictEqual(print(block.program), 'A');
    assert.strictEqual(block.inverse?.type, 'Block');
    if (block.inverse) {
      assert.strictEqual(print(block.inverse), 'B');
    }
    assert.deepEqual(block.inverse?.params, []);
    assert.deepEqual(block.inverse?.blockParams, []);
  });

  QUnit.test('catch params are VarHeads with exact multiline identifier spans', (assert) => {
    const source =
      '{{#try error retry=error}}error retry\n{{~catch as |\n error retry\n|~}}{{error.message}}{{retry}}{{/try}}';
    const block = blockFor(source);
    assert.true(block.catch);
    assert.deepEqual(block.inverse?.blockParams, ['error', 'retry']);
    assert.deepEqual(
      block.inverse?.params.map(({ type, name }) => ({ type, name })),
      [
        { type: 'VarHead', name: 'error' },
        { type: 'VarHead', name: 'retry' },
      ]
    );
    const params = block.inverse?.params ?? [];
    assert.strictEqual(params.length, 2);
    const paramStart = source.indexOf('|', source.indexOf('{{~catch')) + 1;
    for (const param of params) {
      const start = source.indexOf(param.name, paramStart);
      assert.deepEqual(
        param.loc.toJSON(),
        span(source, start, start + param.name.length),
        param.name
      );
      assert.strictEqual(param.loc.asString(), param.name);
    }
  });

  for (const [name, source] of [
    ['empty catch body', '{{#try}}x{{catch as |e|}}{{/try}}'],
    ['empty try body', '{{#try}}{{catch as |e|}}y{{/try}}'],
    ['both bodies empty', '{{#try}}{{catch as |e|}}{{/try}}'],
  ] as const) {
    QUnit.test(`locates params and inverse with ${name}`, (assert) => {
      const block = blockFor(source);
      const catchStart = source.indexOf('{{catch');
      const catchEnd = source.indexOf('}}', catchStart) + 2;
      const closeStart = source.indexOf('{{/try}}');
      const paramStart = source.indexOf('e', source.indexOf('|', catchStart));
      assert.true(block.catch);
      assert.deepEqual(
        block.inverse?.params[0]?.loc.toJSON(),
        span(source, paramStart, paramStart + 1)
      );
      assert.deepEqual(block.inverse?.blockParams, ['e']);
      assert.deepEqual(block.inverse?.loc.toJSON(), span(source, catchEnd, closeStart));
      if (block.inverse) {
        assert.strictEqual(print(block.inverse), source.slice(catchEnd, closeStart));
      }
      assert.strictEqual(block.program.body.length, name === 'empty catch body' ? 1 : 0);
      assert.strictEqual(block.inverse?.body.length, name === 'empty try body' ? 1 : 0);
    });
  }

  QUnit.test('nested catch flags and params belong to their own blocks', (assert) => {
    const ast = preprocess(
      '{{#try}}{{#foo}}A{{catch as |inner|}}B{{/foo}}{{catch as |outer|}}C{{/try}}'
    );
    const catches: string[][] = [];
    traverse(ast, {
      BlockStatement(node) {
        assert.true((node as ASTv1.BlockStatement & { catch?: boolean }).catch);
        assert.ok(node.inverse);
        if (node.inverse) {
          catches.push(node.inverse.blockParams);
        }
      },
    });
    assert.deepEqual(catches, [['outer'], ['inner']]);
  });

  QUnit.test('a local named catch is still parsed as an empty catch clause', (assert) => {
    const block = blockFor('{{#let x as |catch|}}{{catch}}{{/let}}');
    assert.true(block.catch);
    assert.deepEqual(block.program.blockParams, ['catch']);
    assert.deepEqual(block.program.body, []);
    assert.strictEqual(block.inverse?.type, 'Block');
    assert.deepEqual(block.inverse?.body, []);
    assert.deepEqual(block.inverse?.params, []);
  });

  QUnit.test(
    'baseline-green guard: ordinary blocks and else chains have no own catch flag',
    (assert) => {
      for (const source of [
        '{{#foo}}A{{/foo}}',
        '{{#foo}}A{{else}}B{{/foo}}',
        '{{#foo}}A{{else if bar}}B{{else}}C{{/foo}}',
      ]) {
        traverse(preprocess(source), {
          BlockStatement(node) {
            assert.false(Object.hasOwn(node, 'catch'), source);
          },
        });
        assert.strictEqual(print(preprocess(source)), source);
      }
    }
  );
});

QUnit.module('[try-catch-syntax] printer and public builder', () => {
  for (const source of [
    '{{#try}}A{{catch}}B{{/try}}',
    '{{#try}}A{{catch as |e|}}{{e.message}}{{/try}}',
    '{{#try}}A{{catch as |e r|}}{{e}}{{r}}{{/try}}',
    '{{#try}}A{{~catch~}}B{{/try}}',
    '{{#try}}A{{~catch as |e r|~}}B{{/try}}',
    '{{#try}}<div>\n  A\n</div>{{catch as |e|}}<p>\n  {{e.message}}\n</p>{{/try}}',
  ]) {
    QUnit.test(`round-trips ${source}`, (assert) => {
      const block = blockFor(source);
      assert.true(block.catch, 'round-trip must retain clause semantics');
      assert.strictEqual(print(block), source);
    });
  }

  QUnit.test('codemod mode preserves standalone and stripped catch whitespace', (assert) => {
    for (const tag of ['{{catch}}', '{{~catch as |e r|~}}']) {
      const source = `before\n{{#try}}\n  <div> A </div>\n  ${tag}\n  <p> B </p>\n{{/try}}\nafter`;
      const ast = preprocess(source, { mode: 'codemod' });
      const block = ast.body.find(
        (node) => node.type === 'BlockStatement'
      ) as ASTv1.BlockStatement & { catch?: boolean };
      assert.true(block.catch);
      assert.strictEqual(print(ast), source);
    }
  });

  QUnit.test('printing reads renamed inverse blockParams through an AST traversal', (assert) => {
    const ast = preprocess('{{#try}}A{{catch as |e r|}}B{{/try}}');
    traverse(ast, {
      BlockStatement(node) {
        assert.ok(node.inverse);
        if (node.inverse) {
          node.inverse.blockParams = ['problem', 'again'];
        }
      },
    });
    assert.strictEqual(print(ast), '{{#try}}A{{catch as |problem again|}}B{{/try}}');
  });

  QUnit.test('public block builder accepts isCatch as its tenth positional argument', (assert) => {
    const buildCatchBlock: (
      ...args: [...Parameters<typeof builders.block>, isCatch?: boolean]
    ) => ASTv1.BlockStatement & { catch?: boolean } = builders.block;
    const block = buildCatchBlock(
      'try',
      [],
      builders.hash([]),
      builders.blockItself([builders.text('A')]),
      builders.blockItself([builders.text('B')], ['e', 'r']),
      undefined,
      undefined,
      { open: true, close: true },
      undefined,
      true
    );
    assert.true(block.catch);
    assert.true(Object.hasOwn(block, 'catch'));
    assert.strictEqual(print(block), '{{#try}}A{{~catch as |e r|~}}B{{/try}}');
  });

  QUnit.test('baseline-green guard: the builder omits catch when isCatch is omitted', (assert) => {
    const block = builders.block(
      'foo',
      [],
      builders.hash([]),
      builders.blockItself([builders.text('A')]),
      builders.blockItself([builders.text('B')])
    );
    assert.false(Object.hasOwn(block, 'catch'));
    assert.strictEqual(print(block), '{{#foo}}A{{else}}B{{/foo}}');
  });

  QUnit.test('baseline-green guard: a shadowed try with else prints as else', (assert) => {
    const source = '{{#let x as |try|}}{{#try}}a{{else}}b{{/try}}{{/let}}';
    const ast = preprocess(source);
    traverse(ast, {
      BlockStatement(node) {
        assert.false(Object.hasOwn(node, 'catch'));
      },
    });
    assert.strictEqual(print(ast), source);
  });
});

QUnit.module('[try-catch-syntax] ASTv2 normalization', () => {
  QUnit.test('normalization names the inverse catch instead of else', (assert) => {
    const [ast] = normalize(src.Source.from('{{#try}}A{{catch as |e|}}B{{/try}}'));
    const block = ast.body[0];
    assert.strictEqual(block?.type, 'InvokeBlock');
    if (block?.type === 'InvokeBlock') {
      assert.deepEqual(
        block.blocks.blocks.map(({ name }) => name.chars),
        ['default', 'catch']
      );
      assert.strictEqual(block.blocks.get('else'), null);
      assert.strictEqual(block.blocks.get('catch')?.block.body[0]?.type, 'HtmlText');
    }
  });

  QUnit.test('baseline-green guard: normalization keeps an ordinary else block', (assert) => {
    const [ast] = normalize(src.Source.from('{{#foo}}A{{else}}B{{/foo}}'));
    const block = ast.body[0];
    assert.strictEqual(block?.type, 'InvokeBlock');
    if (block?.type === 'InvokeBlock') {
      assert.deepEqual(
        block.blocks.blocks.map(({ name }) => name.chars),
        ['default', 'else']
      );
      assert.strictEqual(block.blocks.get('catch'), null);
    }
  });
});

QUnit.module('[try-catch-syntax] block-only reservation and locals', () => {
  QUnit.test(
    'catch params are scoped to the fallback and the try block path is omitted',
    (assert) => {
      assert.deepEqual(getTemplateLocals('{{#try}}{{foo}}{{catch as |e|}}{{e.message}}{{/try}}'), [
        'foo',
      ]);
      assert.deepEqual(
        getTemplateLocals('{{#try}}{{foo}}{{catch as |e r|}}{{e.message}}{{r}}{{/try}}{{e}}{{r}}'),
        ['foo', 'e', 'r']
      );
      assert.deepEqual(
        getTemplateLocals('{{#try}}{{e}}{{catch as |e r|}}{{e.message}}{{r}}{{/try}}{{e}}{{r}}'),
        ['e', 'r']
      );
    }
  );

  QUnit.test('try exclusion applies per occurrence rather than per name', (assert) => {
    assert.deepEqual(getTemplateLocals('{{#try}}{{try x}}{{/try}}'), ['try', 'x']);
    assert.deepEqual(getTemplateLocals('{{#try}}{{foo}}{{/try}}{{try x}}'), ['foo', 'try', 'x']);
    assert.deepEqual(getTemplateLocals('{{#try}}{{try}}{{/try}}'), ['try']);
  });

  QUnit.test('only block paths named try are excluded from locals', (assert) => {
    assert.deepEqual(getTemplateLocals('{{#try}}{{foo}}{{/try}}'), ['foo']);
    assert.deepEqual(getTemplateLocals('{{#foo try}}{{/foo}}'), ['foo', 'try']);
    assert.deepEqual(getTemplateLocals('{{#foo value=try}}{{/foo}}'), ['foo', 'try']);
    assert.deepEqual(getTemplateLocals('{{#try}}{{foo}}{{/try}}', { includeKeywords: true }), [
      'try',
      'foo',
    ]);
  });

  QUnit.test(
    'baseline-green guard: try is not a global keyword or reserved outside blocks',
    (assert) => {
      assert.false(isKeyword('try'));
      for (const source of [
        '{{try}}',
        '{{(try)}}',
        '<div {{try}}></div>',
        '{{try x}}',
        '{{foo (try x)}}',
      ]) {
        assert.deepEqual(
          getTemplateLocals(source),
          source.includes(' x')
            ? source.startsWith('{{foo')
              ? ['foo', 'try', 'x']
              : ['try', 'x']
            : ['try'],
          source
        );
      }
    }
  );
});
