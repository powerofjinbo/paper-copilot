/** Agent service (Agent SDK, read-only agents). See service.ts. */
export { createAgentService, type AgentServiceOptions, type AgentServiceExt } from './service';
export { buildQueryOptions, READ_ONLY_TOOLS, DISALLOWED_TOOLS, ISOLATION_ENV, SKILL_NAME } from './options';
export { createReadOnlyGuard } from './guard';
export { ensureSkillLink, skillLinkPath } from './skill';
