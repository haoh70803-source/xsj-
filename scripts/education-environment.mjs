/** Keep business session logs and agent configuration separate from the coding deployment. */
import { resolve } from 'node:path'

process.env.DSH_HOME = resolve(process.env.EDUCATION_HARNESS_HOME ?? '.cache/education-harness')
process.env.DSH_AGENTS_HOME = resolve(process.env.EDUCATION_AGENTS_HOME ?? '.cache/education-agent-config')
