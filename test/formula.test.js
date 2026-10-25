'use strict'

const assert = require('node:assert/strict')
const { test } = require('node:test')

const { availableFunctions, checkName, compileFormula } = require('../lib/formula')

const run = (expression, values) => compileFormula(expression, Object.keys(values)).evaluate(values)

test('arithmetic over named inputs', () => {
  assert.equal(run('i * v', { i: 2.5, v: 26.3 }), 65.75)
  assert.equal(run('(a - b) / 3600 + c', { a: 7200, b: 3600, c: 10 }), 11)
  assert.equal(run('a ^ 2 + b % 3', { a: 3, b: 8 }), 11)
  assert.equal(run('-a + 2 * PI', { a: 0 }), 2 * Math.PI)
})

test('conditions and comparisons', () => {
  assert.equal(run('rev > 0 ? 1 : 0', { rev: 12 }), 1)
  assert.equal(run('rev > 0 ? 1 : 0', { rev: 0 }), 0)
  assert.equal(run('a > 1 and b < 5 ? 10 : 20', { a: 2, b: 9 }), 20)
  // A bare comparison is published as 1 or 0.
  assert.equal(run('a >= b', { a: 2, b: 2 }), 1)
  assert.equal(run('not (a >= b)', { a: 2, b: 2 }), 0)
})

test('built-in functions', () => {
  assert.equal(run('max(a, 0)', { a: -3 }), 0)
  assert.equal(run('min(a, b, 7)', { a: 9, b: 8 }), 7)
  assert.equal(run('abs(a) + sqrt(b)', { a: -3, b: 16 }), 7)
  assert.equal(run('roundTo(a, 2)', { a: 3.14159 }), 3.14)
  assert.equal(run('round(a) + floor(a) + ceil(a)', { a: 2.4 }), 7)
  assert.ok(availableFunctions().includes('atan2'))
  assert.ok(!availableFunctions().includes('random'))
})

test('results that are not finite numbers are withheld', () => {
  assert.equal(run('a / b', { a: 1, b: 0 }), null)
  assert.equal(run('sqrt(a)', { a: -1 }), null)
  assert.equal(run('"text"', {}), null)
})

test('an expression naming something that is not an input is refused at compile time', () => {
  assert.throws(() => compileFormula('i * volts', ['i', 'v']), /uses "volts"/)
  assert.throws(() => compileFormula('', ['i']), /empty/)
  assert.throws(() => compileFormula('i *', ['i']), /does not parse/)
})

test('language features beyond arithmetic are switched off', () => {
  const refused = [
    'a = 5', // assignment
    'f(x) = x; f(2)', // function definition
    'a.constructor', // member access
    'a.b',
    '[1, 2, 3]', // arrays
    '"a" || "b"', // string concatenation
    '5!', // factorial
    'a in [1, 2]'
  ]
  for (const expression of refused) {
    assert.throws(() => compileFormula(expression, ['a']), undefined, expression)
  }
  // Names that reach for JavaScript internals never evaluate.
  for (const expression of ['constructor', '__proto__', 'toString', 'process', 'require']) {
    assert.throws(() => compileFormula(expression, []), undefined, expression)
  }
  // Removed array and random helpers are unknown names.
  assert.throws(() => compileFormula('random()', []))
  assert.throws(() => compileFormula('map(a, a)', ['a']))
})

test('short names are validated', () => {
  assert.equal(checkName('i'), null)
  assert.equal(checkName('volts_2'), null)
  assert.match(checkName('2volts'), /not a valid short name/)
  assert.match(checkName('a.b'), /not a valid short name/)
  assert.match(checkName('a-b'), /not a valid short name/)
  assert.match(checkName('max'), /built-in/)
  assert.match(checkName('sin'), /built-in/)
  assert.match(checkName('PI'), /built-in/)
  assert.match(checkName('and'), /built-in/)
  // Names every JavaScript object carries would never yield a value.
  for (const name of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.match(checkName(name), /built-in/, name)
  }
})

test('a parse error is explained in words a user can act on', () => {
  const message = (expression) => { try { compileFormula(expression, ['a', 'b']) } catch (err) { return err.message } return null }
  assert.equal(message('a *'), 'the expression does not parse: it ends too soon, after an operator, a comma or an opening bracket')
  assert.equal(message('a +* 2'), 'the expression does not parse: "*" is out of place; an operator needs a value on each side')
  assert.equal(message('a / (b'), 'the expression does not parse: a closing bracket is missing at the end')
  assert.equal(message('max(a, b'), 'the expression does not parse: a closing bracket is missing at the end')
  assert.equal(message('(a b)'), 'the expression does not parse: "b" at character 4 is out of place; a closing bracket, or an operator before it, is missing')
  assert.equal(message('(a, b) * 2'), 'the expression does not parse: the comma at character 3 is not inside a function\'s brackets; a comma separates the values of a function, as in max(a, b)')
  assert.equal(message('(a * b))'), 'the expression does not parse: the ")" at character 8 has no opening bracket')
  assert.equal(message('sqrt()'), 'the expression does not parse: a ")" comes where a value belongs: the brackets hold nothing, or a value is missing before it')
  assert.equal(message('max(,a)'), 'the expression does not parse: a "," comes where a value belongs: a value is missing before it')
  assert.equal(message('a ? b'), 'the expression does not parse: "?" needs ":" and a second value, as in condition ? a : b')
  assert.equal(message('a b'), 'the expression does not parse: "b" at character 3 is left over; two values need an operator between them')
  assert.equal(message('a = 2'), 'the expression does not parse: "=" cannot be used at character 3; compare with ==, !=, >= or <=')
  assert.equal(message('a & b'), 'the expression does not parse: "&" cannot be used at character 3; write and')
  assert.equal(message('a.b'), 'the expression does not parse: a path cannot be written in the expression; add it as an input and use its short name')
  // No message shows the library's token names.
  for (const bad of ['a *', 'a +* 2', '* a', 'max(a,', 'a ? b :', '(a', 'a)', '[a]', 'a$', ')', 'sqrt()', 'max(,a)', 'max(a,)']) assert.doesNotMatch(message(bad), /TEOF|TOP|TPAREN|TCOMMA|EOF|parse error \[/)
})
