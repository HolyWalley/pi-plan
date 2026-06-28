/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "package" | "user" | "project" | "both" | "all";
export type AgentSource = "package" | "user" | "project";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: AgentSource;
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	packageAgentsDir: string;
	projectAgentsDir: string | null;
}

interface AgentOverride {
	model?: string;
	tools?: string[];
}

interface PlanConfig {
	agents?: Record<string, AgentOverride>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPlanConfig(filePath: string): PlanConfig {
	if (!fs.existsSync(filePath)) return {};
	try {
		const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
		if (!isRecord(parsed) || !isRecord(parsed.agents)) return {};

		const agents: Record<string, AgentOverride> = {};
		for (const [name, override] of Object.entries(parsed.agents)) {
			if (!isRecord(override)) continue;
			const model = typeof override.model === "string" && override.model.trim() ? override.model.trim() : undefined;
			const tools = Array.isArray(override.tools) ? override.tools.filter((tool): tool is string => typeof tool === "string") : undefined;
			agents[name] = { model, tools };
		}
		return { agents };
	} catch {
		return {};
	}
}

function mergePlanConfigs(base: PlanConfig, override: PlanConfig): PlanConfig {
	return { agents: { ...(base.agents ?? {}), ...(override.agents ?? {}) } };
}

function getPlanConfig(cwd: string): PlanConfig {
	const userConfig = readPlanConfig(path.join(getAgentDir(), "pi-plan.json"));
	const projectConfig = readPlanConfig(path.join(cwd, CONFIG_DIR_NAME, "pi-plan.json"));
	return mergePlanConfigs(userConfig, projectConfig);
}

function applyPlanConfig(agents: AgentConfig[], config: PlanConfig): AgentConfig[] {
	return agents.map((agent) => {
		const override = config.agents?.[agent.name];
		if (!override) return agent;
		return {
			...agent,
			model: override.model ?? agent.model,
			tools: override.tools && override.tools.length > 0 ? override.tools : agent.tools,
		};
	});
}

function loadAgentsFromDir(dir: string, source: AgentSource): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: frontmatter.model,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function getPackageAgentsDir(): string {
	const thisFile = fileURLToPath(import.meta.url);
	return path.resolve(path.dirname(thisFile), "..", "..", "agents");
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const packageAgentsDir = getPackageAgentsDir();
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const packageAgents = scope === "project" || scope === "user" || scope === "both" ? [] : loadAgentsFromDir(packageAgentsDir, "package");
	const userAgents = scope === "package" || scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "package" || scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	for (const agent of packageAgents) agentMap.set(agent.name, agent);
	for (const agent of userAgents) agentMap.set(agent.name, agent);
	for (const agent of projectAgents) agentMap.set(agent.name, agent);

	const agents = applyPlanConfig(Array.from(agentMap.values()), getPlanConfig(cwd));
	return { agents, packageAgentsDir, projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
