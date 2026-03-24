import { z } from 'zod'

// --- Teams schema (strict: rejects unknown keys) ---

const ConstraintsSchema = z
	.object({
		max_usd: z.number().positive(),
		max_minutes: z.number().positive(),
		task_timeout_ms: z.number().positive().optional().default(120000),
		max_concurrency: z.number().int().positive(),
	})
	.strict()
	.transform((c) => ({
		maxUsd: c.max_usd,
		maxMinutes: c.max_minutes,
		taskTimeoutMs: c.task_timeout_ms,
		maxConcurrency: c.max_concurrency,
	}))

const OrchestratorSchema = z
	.object({
		model: z.string().min(1),
		skills: z.array(z.string()).default([]),
	})
	.strict()
	.transform((o) => ({
		model: o.model,
		skills: o.skills,
	}))

export const TeamSchema = z
	.object({
		team_id: z.string().min(1),
		orchestrator: OrchestratorSchema,
		members: z.array(z.string().min(1)).min(1),
		constraints: ConstraintsSchema,
	})
	.strict()
	.transform((t) => ({
		teamId: t.team_id,
		orchestrator: t.orchestrator,
		members: t.members,
		constraints: t.constraints,
	}))

export type Team = z.infer<typeof TeamSchema>

// --- Agent front matter schema (passthrough: forward-compat) ---

export const AgentFrontmatterSchema = z
	.object({
		name: z.string().min(1),
		model: z.string().min(1),
		skills: z.array(z.string()).optional(),
		expertise: z.string().optional(),
		thinking: z.string().optional(),
	})
	.passthrough()

export type AgentFrontmatter = z.infer<typeof AgentFrontmatterSchema>

export interface AgentDefinition {
	id: string
	frontmatter: AgentFrontmatter
	body: string
}

// --- Chain schema ---

const ChainStepSchema = z.object({
	agent: z.string().min(1),
	prompt: z.string().optional(),
})

export const ChainSchema = z.object({
	name: z.string().min(1),
	steps: z.array(ChainStepSchema).min(1),
})

export type Chain = z.infer<typeof ChainSchema>
export type ChainStep = z.infer<typeof ChainStepSchema>
