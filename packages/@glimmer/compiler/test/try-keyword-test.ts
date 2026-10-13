import type { PrecompileOptions } from '@glimmer/compiler';
import type { SerializedTemplateBlock, SerializedTemplateWithLazyBlock } from '@glimmer/interfaces';
import { precompile } from '@glimmer/compiler';
import type { GlimmerSyntaxError } from '@glimmer/syntax';
import { SexpOpcodes } from '@glimmer/wire-format';

/** The assigned wire opcode, intentionally independent of the future implementation export. */
const TRY_OPCODE = 43;

/** Read the raw block, including when precompile embeds a JavaScript lexical-scope function. */
function compile(
  source: string,
  options: PrecompileOptions & { lexicalScope?: (name: string) => boolean } = {}
): SerializedTemplateBlock {
  // The scope function is irrelevant to wire assertions. Do not evaluate generated JavaScript.
  let json = precompile(source, options).replace(/"scope":\(\)=>\(\{[^}]*\}\)/u, '"scope":null');
  let template = JSON.parse(json) as SerializedTemplateWithLazyBlock;
  return JSON.parse(template.block) as SerializedTemplateBlock;
}

/** Pin keyword upvar allocation against an if control in the same compilation mode. */
function tryUpvars(options: PrecompileOptions = {}): string[] {
  return compile('{{#if @x}}body{{/if}}', options)[2].map((name) => (name === 'if' ? 'try' : name));
}

/** Obtain parameter slots and local lookups from an equivalent, supported let block. */
function letBlock(template: SerializedTemplateBlock) {
  let statement = template[0][0];
  if (statement?.[0] !== SexpOpcodes.Let) {
    throw new Error('Oracle control template must start with a let opcode');
  }
  return statement[2];
}

/** Assert a diagnostic substring while permitting the source location suffix. */
function errorTest(
  name: string,
  source: string,
  message: string,
  options: PrecompileOptions & { lexicalScope?: (name: string) => boolean } = {}
) {
  QUnit.test(name, (assert) => {
    assert.throws(
      () => compile(source, options),
      (error: unknown) => error instanceof Error && error.message.includes(message),
      message
    );
  });
}

QUnit.module('[try-keyword-compiler] raw wire format', () => {
  for (let strictMode of [false, true]) {
    let mode = strictMode ? 'strict' : 'loose';
    let options = { strictMode };

    QUnit.test(`W1 ${mode}: no catch is null and try upvars match if`, (assert) => {
      assert.deepEqual<unknown>(compile('{{#try}}body{{/try}}', options), [
        [[TRY_OPCODE, [compile('body', options)[0], []], null]],
        [],
        tryUpvars(options),
      ]);
    });

    QUnit.test(`W1/W2 ${mode}: bare catch has an inline block with no params`, (assert) => {
      assert.deepEqual<unknown>(compile('{{#try}}body{{catch}}fallback{{/try}}', options), [
        [[TRY_OPCODE, [compile('body', options)[0], []], [compile('fallback', options)[0], []]]],
        [],
        tryUpvars(options),
      ]);
    });

    QUnit.test(`W1 ${mode}: empty catch remains a block rather than null`, (assert) => {
      assert.deepEqual<unknown>(compile('{{#try}}{{catch}}{{/try}}', options), [
        [[TRY_OPCODE, [[], []], [[], []]]],
        [],
        tryUpvars(options),
      ]);
    });

    QUnit.test(`W2 ${mode}: one catch param supplies a local path lookup`, (assert) => {
      let control = compile('{{#let null as |e|}}{{e.message}}{{/let}}', options);
      let fallback = letBlock(control);
      assert.strictEqual(fallback[1].length, 1, 'control has one parameter slot');
      assert.deepEqual<unknown>(
        compile('{{#try}}body{{catch as |e|}}{{e.message}}{{/try}}', options),
        [
          [[TRY_OPCODE, [compile('body', options)[0], []], fallback]],
          control[1],
          tryUpvars(options),
        ]
      );
    });

    QUnit.test(`W2 ${mode}: two catch params preserve order and local lookups`, (assert) => {
      let control = compile('{{#let null null as |e r|}}{{r}}{{e.message}}{{e}}{{/let}}', options);
      let fallback = letBlock(control);
      assert.strictEqual(fallback[1].length, 2, 'control has two parameter slots');
      assert.deepEqual<unknown>(
        compile('{{#try}}body{{catch as |e r|}}{{r}}{{e.message}}{{e}}{{/try}}', options),
        [
          [[TRY_OPCODE, [compile('body', options)[0], []], fallback]],
          control[1],
          tryUpvars(options),
        ]
      );
    });

    QUnit.test(`W3 ${mode}: if and each compile inside both blocks`, (assert) => {
      let body =
        '{{#if @ok}}{{#each @items as |item i|}}{{item.name}}{{i}}{{else}}empty{{/each}}{{else}}no{{/if}}';
      let control = compile(`{{#if true}}${body}{{else}}${body}{{/if}}`, options);
      let outerIf = control[0][0];
      if (outerIf?.[0] !== SexpOpcodes.If) {
        throw new Error('Oracle control template must start with an if opcode');
      }
      assert.deepEqual<unknown>(compile(`{{#try}}${body}{{catch}}${body}{{/try}}`, options), [
        [[TRY_OPCODE, outerIf[2], outerIf[3]]],
        control[1],
        [...tryUpvars(options), ...control[2]],
      ]);
    });
  }

  QUnit.test(
    'W2 loose: catch locals do not leak into the try body or following siblings',
    (assert) => {
      let control = compile(
        '{{#if true}}{{/if}}{{e}}{{#let null null as |e r|}}{{e.message}}{{r}}{{/let}}{{e}}'
      );
      assert.deepEqual<unknown>(
        compile('{{#try}}{{e}}{{catch as |e r|}}{{e.message}}{{r}}{{/try}}{{e}}'),
        [
          [
            [
              TRY_OPCODE,
              [[control[0][1]], []],
              letBlock([control[0].slice(2), control[1], control[2]]),
            ],
            control[0][3],
          ],
          control[1],
          control[2].filter((name) => name !== 'let').map((name) => (name === 'if' ? 'try' : name)),
        ]
      );
    }
  );

  errorTest(
    'W2 strict: catch params are not in scope in the try body',
    '{{#try}}{{e}}{{catch as |e r|}}{{e.message}}{{r}}{{/try}}',
    'Attempted to resolve a value in a strict mode template, but that value was not in scope: e',
    { strictMode: true }
  );

  QUnit.test('W3: try nests in the try body with a distinct catch', (assert) => {
    assert.deepEqual<unknown>(
      compile(
        '{{#try}}before{{#try}}inner{{catch}}inner fallback{{/try}}after{{catch}}outer fallback{{/try}}'
      ),
      [
        [
          [
            TRY_OPCODE,
            [
              [
                ...compile('before')[0],
                [TRY_OPCODE, [compile('inner')[0], []], [compile('inner fallback')[0], []]],
                ...compile('after')[0],
              ],
              [],
            ],
            [compile('outer fallback')[0], []],
          ],
        ],
        [],
        tryUpvars(),
      ]
    );
  });

  QUnit.test(
    'W2/W3 strict: nested catch shadows its parent and restores the outer local',
    (assert) => {
      let options = { strictMode: true };
      let control = compile(
        '{{#let null as |e|}}{{e.message}}{{#let null null as |e r|}}{{e.message}}{{r}}{{/let}}{{e.message}}{{/let}}',
        options
      );
      let outer = letBlock(control);
      let inner = letBlock([outer[0].slice(1), control[1], control[2]]);
      assert.deepEqual<unknown>(
        compile(
          '{{#try}}body{{catch as |e|}}{{e.message}}{{#try}}{{e.message}}{{catch as |e r|}}{{e.message}}{{r}}{{/try}}{{e.message}}{{/try}}',
          options
        ),
        [
          [
            [
              TRY_OPCODE,
              [compile('body')[0], []],
              [[outer[0][0], [TRY_OPCODE, [[outer[0][0]], []], inner], outer[0][2]], outer[1]],
            ],
          ],
          control[1],
          tryUpvars(options),
        ]
      );
    }
  );

  QUnit.test('W3: try compiles inside an element', (assert) => {
    let control = compile('<div>body</div>');
    assert.deepEqual<unknown>(compile('<div>{{#try}}body{{catch}}fallback{{/try}}</div>'), [
      [
        ...control[0].slice(0, 2),
        [TRY_OPCODE, [compile('body')[0], []], [compile('fallback')[0], []]],
        ...control[0].slice(3),
      ],
      control[1],
      [...control[2], ...tryUpvars()],
    ]);
  });

  QUnit.test('W3: try compiles inside a component named block', (assert) => {
    let control = compile('<Panel><:content>body</:content><:else>other</:else></Panel>');
    let component = control[0][0];
    if (component?.[0] !== SexpOpcodes.Component || component[4] === null) {
      throw new Error('Oracle control template must contain component named blocks');
    }
    assert.deepEqual<unknown>(
      compile(
        '<Panel><:content>{{#try}}body{{catch}}fallback{{/try}}</:content><:else>other</:else></Panel>'
      ),
      [
        [
          [
            ...component.slice(0, 4),
            [
              component[4][0],
              [
                [[[TRY_OPCODE, [compile('body')[0], []], [compile('fallback')[0], []]]], []],
                component[4][1][1],
              ],
            ],
          ],
        ],
        control[1],
        compile(
          '<Panel><:content>{{#if true}}body{{/if}}</:content><:else>other</:else></Panel>'
        )[2].map((name) => (name === 'if' ? 'try' : name)),
      ]
    );
  });

  QUnit.test('W2: sibling catches allocate separate local symbols', (assert) => {
    let control = compile(
      '{{#let null as |e|}}{{e.message}}{{/let}}{{#let null as |e|}}{{e.message}}{{/let}}'
    );
    let first = letBlock(control);
    let second = letBlock([control[0].slice(1), control[1], control[2]]);
    assert.notDeepEqual(first[1], second[1], 'control allocates distinct sibling slots');
    assert.deepEqual<unknown>(
      compile(
        '{{#try}}one{{catch as |e|}}{{e.message}}{{/try}}{{#try}}two{{catch as |e|}}{{e.message}}{{/try}}'
      ),
      [
        [
          [TRY_OPCODE, [compile('one')[0], []], first],
          [TRY_OPCODE, [compile('two')[0], []], second],
        ],
        control[1],
        tryUpvars(),
      ]
    );
  });
});

QUnit.module('[try-keyword-compiler] compile errors', () => {
  errorTest(
    'E1: positional arguments are rejected',
    '{{#try x}}a{{/try}}',
    '{{#try}} does not take arguments'
  );
  errorTest(
    'E1: named arguments are rejected',
    '{{#try a=1}}a{{/try}}',
    '{{#try}} does not take arguments'
  );
  errorTest(
    'E2: try block params are rejected',
    '{{#try as |x|}}a{{/try}}',
    '{{#try}} does not take block params'
  );
  errorTest(
    'E3: else requires catch instead',
    '{{#try}}a{{else}}b{{/try}}',
    '{{#try}} does not support {{else}}; use {{catch}}'
  );

  for (let params of ['e r extra', 'e r extra fourth']) {
    errorTest(
      `E4: catch rejects ${params.split(' ').length} params`,
      `{{#try}}a{{catch as |${params}|}}b{{/try}}`,
      '{{catch}} accepts at most two block params (error and retry)'
    );
  }

  let invalidCatchMessage = '{{catch}} is only valid on {{#try}}';
  errorTest(
    'E5: catch on a curly component or helper is rejected',
    '{{#my-comp}}a{{catch}}b{{/my-comp}}',
    invalidCatchMessage
  );

  for (let [keyword, args] of [
    ['if', 'true'],
    ['unless', 'false'],
    ['each', '@items'],
    ['let', 'null as |x|'],
    ['in-element', '@target'],
    ['-with-dynamic-vars', 'a=1'],
    ['component', '@definition'],
  ]) {
    errorTest(
      `E5: catch on ${keyword} is rejected`,
      `{{#${keyword} ${args}}}a{{catch}}b{{/${keyword}}}`,
      invalidCatchMessage
    );
  }

  for (let keyword of ['if', 'unless', 'each', 'let', 'in-element', 'component']) {
    errorTest(
      `E5: catch rejection precedes ${keyword} argument validation`,
      `{{#${keyword}}}a{{catch}}b{{/${keyword}}}`,
      invalidCatchMessage
    );
  }

  for (let path of ['this.try', '@try']) {
    errorTest(
      `E5: catch on ${path} is rejected`,
      `{{#${path}}}a{{catch}}b{{/${path}}}`,
      invalidCatchMessage
    );
  }
  errorTest(
    'E5: catch on a local named try is rejected',
    '{{#let x as |try|}}{{#try}}a{{catch}}b{{/try}}{{/let}}',
    invalidCatchMessage
  );
  errorTest(
    'E5: a local named catch cannot turn the clause into an append',
    '{{#let x as |catch|}}{{catch}}{{/let}}',
    invalidCatchMessage
  );
  errorTest(
    'E5: catch on a lexical named try is rejected',
    '{{#try}}a{{catch}}b{{/try}}',
    invalidCatchMessage,
    { strictMode: true, lexicalScope: (name) => name === 'try' }
  );
  QUnit.test('try.foo: additional keyword path segments are rejected', (assert) => {
    for (let strictMode of [false, true]) {
      let options = { strictMode };
      let control: Error | undefined;
      try {
        compile('{{#if.foo}}a{{/if.foo}}', options);
      } catch (error) {
        if (error instanceof Error) control = error;
      }
      assert.ok(control, 'if.foo control rejects the qualified callee');
      assert.throws(
        () => compile('{{#try.foo}}a{{/try.foo}}', options),
        (error: unknown) =>
          error instanceof Error && error.message === control?.message.replaceAll('if', 'try'),
        `${strictMode ? 'strict' : 'loose'} diagnostic matches if.foo with the name swapped`
      );
    }
  });
});

QUnit.module('[try-keyword-compiler] shadowing and block-only reservation', () => {
  QUnit.test('S1 baseline-green guard: local try invokes default and else blocks', (assert) => {
    let actual = compile('{{#let x as |try|}}{{#try}}a{{else}}b{{/try}}{{/let}}');
    let control = compile('{{#let x as |zzz|}}{{#zzz}}a{{else}}b{{/zzz}}{{/let}}');
    assert.deepEqual<unknown>(actual[0], control[0]);
    assert.deepEqual<unknown>(
      actual[1],
      control[1].map((name) => (name === 'zzz' ? 'try' : name))
    );
    assert.deepEqual<unknown>(actual[2], control[2]);
    assert.strictEqual(letBlock(actual)[0][0]?.[0], SexpOpcodes.Block);
  });

  QUnit.test(
    'S2 baseline-green guard: lexical try invokes its scoped value in strict mode',
    (assert) => {
      let actual = compile('{{#try}}a{{/try}}', {
        strictMode: true,
        lexicalScope: (name) => name === 'try',
      });
      let control = compile('{{#zzz}}a{{/zzz}}', {
        strictMode: true,
        lexicalScope: (name) => name === 'zzz',
      });
      assert.deepEqual<unknown>(actual, [
        control[0],
        control[1],
        control[2].map((name) => (name === 'zzz' ? 'try' : name)),
      ]);
      assert.strictEqual(actual[0][0]?.[0], SexpOpcodes.Block);
      assert.deepEqual<unknown>(actual[0][0]?.[1], [SexpOpcodes.GetLexicalSymbol, 0]);
    }
  );

  errorTest(
    'S3 baseline-green guard: strict append try remains not in scope',
    '{{try x}}',
    'Attempted to resolve a component or helper in a strict mode template, but that value was not in scope: try',
    { strictMode: true }
  );
  errorTest(
    'S3 baseline-green guard: strict subexpression try remains not in scope',
    '{{this.foo (try)}}',
    'Attempted to resolve a helper in a strict mode template, but that value was not in scope: try',
    { strictMode: true }
  );

  for (let [position, source] of [
    ['append', '{{try x}}'],
    ['subexpression', '{{foo (try x)}}'],
    ['modifier', '<div {{try}}></div>'],
  ] as const) {
    QUnit.test(`S4 baseline-green guard: loose ${position} try is an ordinary lookup`, (assert) => {
      let actual = compile(source);
      let control = compile(source.replace('try', 'zzz'));
      assert.deepEqual<unknown>(actual, [
        control[0],
        control[1],
        control[2].map((name) => (name === 'zzz' ? 'try' : name)),
      ]);
      assert.true(actual[2].includes('try'), 'ordinary try is retained in upvars');
    });
  }

  errorTest(
    'S5: strict scope validation visits the try body',
    '{{#try}}{{missingBody}}{{catch}}fallback{{/try}}',
    'Attempted to resolve a value in a strict mode template, but that value was not in scope: missingBody',
    { strictMode: true }
  );
  errorTest(
    'S5: strict scope validation visits the catch body',
    '{{#try}}body{{catch as |e|}}{{e.message}}{{missingCatch}}{{/try}}',
    'Attempted to resolve a value in a strict mode template, but that value was not in scope: missingCatch',
    { strictMode: true }
  );
});

QUnit.module('[try-keyword-compiler] review', () => {
  for (let strictMode of [false, true]) {
    let mode = strictMode ? 'strict' : 'loose';
    for (let [rule, callee, clause, message] of [
      ['E3', 'try', '{{else}}', '{{#try}} does not support {{else}}; use {{catch}}'],
      [
        'E4',
        'try',
        '{{catch as |e r extra|}}',
        '{{catch}} accepts at most two block params (error and retry), received 3',
      ],
      ['E5', 'if true', '{{catch}}', '{{catch}} is only valid on {{#try}}'],
    ] as const) {
      QUnit.test(`${rule} ${mode}: diagnostic span includes the offending clause`, (assert) => {
        for (let fallback of ['\n  unrelated fallback', '']) {
          let closing = callee.split(' ')[0];
          let source = `{{#${callee}}}\n  body\n  ${clause}${fallback}{{/${closing}}}`;
          let diagnostic: GlimmerSyntaxError | undefined;
          assert.throws(
            () => compile(source, { strictMode }),
            (error: unknown) => {
              if (error instanceof Error && error.message.includes(message)) {
                diagnostic = error as GlimmerSyntaxError;
                return true;
              }
              return false;
            },
            `${fallback ? 'populated' : 'empty'} inverse has the expected diagnostic`
          );
          let includesClause = diagnostic?.location?.asString().includes(clause) ?? false;
          assert.true(
            includesClause,
            'highlighted source includes the clause, not just its fallback body'
          );
          let start = diagnostic?.location?.loc.start;
          let startsBeforeClause =
            start !== undefined && (start.line < 3 || (start.line === 3 && start.column <= 2));
          assert.true(
            startsBeforeClause,
            'the diagnostic starts at or before the offending clause'
          );
        }
      });
    }
  }
});
