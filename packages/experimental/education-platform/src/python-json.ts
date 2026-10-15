/** Python V1 JSON-number compatibility using native parser source tokens; no model or Python process runs here. */
import type { ResearchJson } from './research-types.ts'
import { EducationError } from './error.ts'

/** Parsed finite JSON plus integer/float distinctions retained from the input lexemes. */
export interface PythonJsonInput {
  readonly value: ResearchJson
  readonly floatFields: WeakMap<object, Set<string>>
}

/**
 * Parse external V1 JSON without discarding the difference between 1 and 1.0.
 * @param raw - complete bounded JSON text.
 * @returns finite JSON with per-parent floating-number fields; malformed or unsafe integer input is refused.
 */
export function parsePythonJson(raw: string): PythonJsonInput {
  const floatFields = new WeakMap<object, Set<string>>()
  const parsed: unknown = JSON.parse(
    raw.replace(/^\uFEFF/, ''),
    function (this: unknown, key: string, value: unknown, context?: { source?: string }): unknown {
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || context?.source === undefined)
          throw new EducationError(
            'validation-failed',
            'V1 numeric input is nonfinite or its lexical type is unavailable',
          )
        const floating = /[.eE]/.test(context.source)
        if (!floating && !Number.isSafeInteger(value))
          throw new EducationError('validation-failed', 'V1 integer exceeds exact JavaScript precision')
        if (floating && typeof this === 'object' && this !== null) {
          const fields = floatFields.get(this) ?? new Set<string>()
          fields.add(key)
          floatFields.set(this, fields)
        }
      }
      if (typeof value === 'string' && !value.isWellFormed())
        throw new EducationError('validation-failed', 'V1 text contains an invalid surrogate')
      return value
    },
  )
  if (!isJsonValue(parsed)) throw new EducationError('validation-failed', 'input contains a non-JSON value')
  return { value: parsed, floatFields }
}

function isJsonValue(value: unknown): value is ResearchJson {
  if (value === null || typeof value === 'boolean' || typeof value === 'string' || typeof value === 'number')
    return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  return (
    typeof value === 'object' &&
    Object.keys(value).every(key => key.isWellFormed()) &&
    Object.values(value).every(isJsonValue)
  )
}

function pythonFloat(value: number): string {
  if (Object.is(value, -0)) return '-0.0'
  const exponential = value.toExponential(),
    match = /^(.*)e([+-])(\d+)$/.exec(exponential)
  if (match === null) throw new EducationError('validation-failed', 'V1 floating representation is invalid')
  const exponent = Number(match[3]) * (match[2] === '-' ? -1 : 1)
  if (exponent < -4 || exponent >= 16) return `${match[1]}e${match[2]}${match[3]?.padStart(2, '0')}`
  const plain = value.toString()
  return plain.includes('.') ? plain : plain + '.0'
}

/**
 * Serialize a normalized V1 transcript using the retained Python integer/float categories.
 * @param value - normalized finite JSON with number categories copied for rebuilt records.
 * @param fields - parser-owned float fields, including any normalized record aliases.
 * @returns compact sorted-key, non-ASCII JSON compatible with the V1 producer.
 */
export function pythonCanonicalJson(value: ResearchJson, fields: WeakMap<object, Set<string>>): string {
  function encode(current: ResearchJson, parent?: object, key?: string): string {
    if (typeof current === 'number')
      return parent !== undefined && key !== undefined && fields.get(parent)?.has(key)
        ? pythonFloat(current)
        : JSON.stringify(current)
    if (current === null || typeof current !== 'object') return JSON.stringify(current)
    if (Array.isArray(current))
      return '[' + current.map((item, index) => encode(item, current, String(index))).join(',') + ']'
    const keys = Object.keys(current).sort((a, b) => {
      const aa = Array.from(a),
        bb = Array.from(b)
      for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
        const av = aa[i]?.codePointAt(0) ?? 0,
          bv = bb[i]?.codePointAt(0) ?? 0
        if (av !== bv) return av - bv
      }
      return aa.length - bb.length
    })
    return (
      '{' +
      keys
        .map((field) => {
          const entry = current[field]
          if (entry === undefined)
            throw new EducationError('validation-failed', 'normalized V1 JSON has an absent value')
          return JSON.stringify(field) + ':' + encode(entry, current, field)
        })
        .join(',') +
      '}'
    )
  }
  return encode(value)
}
