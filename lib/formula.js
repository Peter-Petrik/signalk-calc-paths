'use strict'

/*
 * Formula parsing and evaluation.
 *
 * Expressions are parsed by expr-eval-fork, which evaluates a token stream
 * and never hands text to the JavaScript engine. The parser is configured
 * for arithmetic only: the language features that are not needed to turn a
 * few numbers into one number are switched off, so a formula cannot assign,
 * define functions, build arrays, join strings or reach into objects. Its
 * result is published only when it is a finite number.
 */

const { Parser } = require('expr-eval-fork')

// A short name stands for a path inside an expression. Paths themselves
// cannot be used: they contain dots and dashes, which are operators.
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

function createParser () {
  const parser = new Parser({
    allowMemberAccess: false,
    operators: {
      assignment: false,
      fndef: false,
      array: false,
      concatenate: false,
      in: false,
      factorial: false
    }
  })

  // These built-ins work on arrays or strings, which the grammar above can
  // no longer produce. Removing them keeps the documented function list
  // honest. `random` goes too: a published value should be reproducible
  // from its inputs.
  for (const name of ['map', 'fold', 'filter', 'indexOf', 'join', 'sum', 'random', 'fac', 'gamma']) {
    delete parser.functions[name]
  }
  delete parser.unaryOps.length

  return parser
}

const parser = createParser()

// Words the parser already gives a meaning to. An input may not take one of
// these as its short name, because the built-in would win silently.
const RESERVED = new Set([
  ...Object.keys(parser.functions),
  ...Object.keys(parser.unaryOps),
  ...Object.keys(parser.consts),
  'and',
  'or',
  'not',
  'in'
])

/**
 * Reports whether a short name can be used for an input.
 * Returns an error message, or null when the name is acceptable.
 */
function checkName (name) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    return `"${name}" is not a valid short name: use letters, digits and underscores, starting with a letter`
  }
  // Names every JavaScript object carries, such as "constructor" and
  // "toString", are refused too: the parser guards against them, so a
  // formula using one would never produce a value.
  if (RESERVED.has(name) || name in {} || name.startsWith('__')) {
    return `"${name}" is a built-in name and cannot be used as a short name`
  }
  return null
}

/**
 * Compiles an expression over a known set of input names.
 *
 * Compilation fails early, with a message fit for the plugin status, when
 * the expression does not parse or mentions a name that is not an input.
 * Catching that at start-up is better than a formula that silently never
 * produces a value.
 *
 * @param {string} expression
 * @param {string[]} names - Short names of the entry's inputs.
 * @returns {{evaluate: function(object): (number|null), variables: string[]}}
 */
function compileFormula (expression, names) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error('the expression is empty')
  }

  let parsed
  try {
    parsed = parser.parse(expression)
  } catch (err) {
    throw new Error(`the expression does not parse: ${err.message}`)
  }

  // symbols() lists every name in the expression, functions included.
  // Each must be an input or a built-in the parser itself owns. Checking
  // ownership matters: a name such as "constructor" or "toString" exists on
  // every JavaScript object, and the library would otherwise accept it as a
  // function name at parse time and only refuse it during evaluation.
  const known = new Set(names)
  const builtIn = (name) => Object.hasOwn(parser.functions, name) || Object.hasOwn(parser.unaryOps, name) || Object.hasOwn(parser.consts, name)
  const unknown = parsed.symbols().filter((name) => !known.has(name) && !builtIn(name))
  const variables = parsed.variables().filter((name) => known.has(name))
  if (unknown.length > 0) {
    throw new Error(`the expression uses ${unknown.map((n) => `"${n}"`).join(', ')}, which is not an input or a built-in function`)
  }

  return {
    variables,
    /**
     * Evaluates the expression. Returns a finite number, or null when the
     * result cannot be published: division by zero, the square root of a
     * negative number, or anything that is not a number.
     */
    evaluate (values) {
      let result
      try {
        result = parsed.evaluate(values)
      } catch (err) {
        return null
      }
      // A bare comparison such as `a > b` yields true or false. Signal K
      // consumers chart numbers, so the result is published as 1 or 0.
      if (typeof result === 'boolean') return result ? 1 : 0
      if (typeof result === 'number' && Number.isFinite(result)) return result
      return null
    }
  }
}

/**
 * Lists the functions an expression may call, for documentation and tests.
 */
function availableFunctions () {
  return [...Object.keys(parser.functions), ...Object.keys(parser.unaryOps).filter((n) => NAME_PATTERN.test(n))].sort()
}

module.exports = { NAME_PATTERN, availableFunctions, checkName, compileFormula }
