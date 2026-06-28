import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	isToolCallEventType,
	type ExtensionAPI,
	type ExtensionContext,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const PLAN_BUILTIN_TOOLS = ["read", "bash", "grep", "find", "ls"];
const PLANNING_EXTENSION_TOOLS = ["plan_ask_user", "plan_submit_draft", "plan_get_status"];
const EXECUTION_EXTENSION_TOOLS = ["plan_ask_user", "plan_get_status", "plan_start_task", "plan_record_task_result"];
const EXTENSION_TOOLS = ["plan_ask_user", "plan_submit_draft", "plan_get_status", "plan_start_task", "plan_record_task_result"];
const PLANNING_TOOLS = [...PLAN_BUILTIN_TOOLS, ...PLANNING_EXTENSION_TOOLS];
const EXTENSION_TOOL_SET = new Set(EXTENSION_TOOLS);
const MUTATION_TOOLS = new Set(["edit", "write"]);
const STATE_ENTRY_TYPE = "plan-extension-state";

type PlanStatus = "idle" | "planning" | "reviewing" | "revising" | "approved" | "executing" | "blocked" | "complete" | "aborted";
type TaskStatus = "pending" | "running" | "complete" | "failed" | "blocked" | "skipped";

interface PlanTask {
	id: string;
	title: string;
	description: string;
	status: TaskStatus;
	dependsOn: string[];
	agent: string;
	modelPreset: string;
	review: boolean;
	validation?: string;
}

interface PlanFile {
	id: string;
	goal: string;
	status: PlanStatus;
	version: number;
	createdAt: string;
	updatedAt: string;
	approvedAt?: string;
	draftPath?: string;
	approvedPath: string | null;
	tasks: PlanTask[];
}

interface RuntimeState {
	status: PlanStatus;
	activePlanId?: string;
	toolsBeforePlanMode?: string[];
	gitignorePrompted?: boolean;
}

interface ReviewResult {
	exitCode: number;
	annotations: string;
	annotationsPath: string;
}

const DESTRUCTIVE_PATTERNS = [
	/\brm\b/i,
	/\brmdir\b/i,
	/\bmv\b/i,
	/\bcp\b/i,
	/\bmkdir\b/i,
	/\btouch\b/i,
	/\bchmod\b/i,
	/\bchown\b/i,
	/\bchgrp\b/i,
	/\bln\b/i,
	/\btee\b/i,
	/\btruncate\b/i,
	/\bdd\b/i,
	/\bshred\b/i,
	/(^|[^<])>(?!>)/,
	/>>/,
	/\bnpm\s+(install|uninstall|update|ci|link|publish)/i,
	/\byarn\s+(add|remove|install|publish)/i,
	/\bpnpm\s+(add|remove|install|publish|update)/i,
	/\bpip\s+(install|uninstall)/i,
	/\bapt(-get)?\s+(install|remove|purge|update|upgrade)/i,
	/\bbrew\s+(install|uninstall|upgrade)/i,
	/\bgit\s+(add|commit|push|pull|merge|rebase|reset|checkout|branch\s+-[dD]|stash|cherry-pick|revert|tag|init|clone)/i,
	/\bsudo\b/i,
	/\bsu\b/i,
	/\bkill\b/i,
	/\bpkill\b/i,
	/\bkillall\b/i,
	/\breboot\b/i,
	/\bshutdown\b/i,
	/\bsystemctl\s+(start|stop|restart|enable|disable)/i,
	/\bservice\s+\S+\s+(start|stop|restart)/i,
	/\b(vim?|nano|emacs|code|subl)\b/i,
];

const SAFE_PATTERNS = [
	/^\s*cat\b/,
	/^\s*head\b/,
	/^\s*tail\b/,
	/^\s*less\b/,
	/^\s*more\b/,
	/^\s*grep\b/,
	/^\s*find\b/,
	/^\s*ls\b/,
	/^\s*pwd\b/,
	/^\s*echo\b/,
	/^\s*printf\b/,
	/^\s*wc\b/,
	/^\s*sort\b/,
	/^\s*uniq\b/,
	/^\s*diff\b/,
	/^\s*file\b/,
	/^\s*stat\b/,
	/^\s*du\b/,
	/^\s*df\b/,
	/^\s*tree\b/,
	/^\s*which\b/,
	/^\s*whereis\b/,
	/^\s*type\b/,
	/^\s*env\b/,
	/^\s*printenv\b/,
	/^\s*uname\b/,
	/^\s*whoami\b/,
	/^\s*id\b/,
	/^\s*date\b/,
	/^\s*cal\b/,
	/^\s*uptime\b/,
	/^\s*ps\b/,
	/^\s*git\s+(status|log|diff|show|branch|remote|config\s+--get)/i,
	/^\s*git\s+ls-/i,
	/^\s*npm\s+(list|ls|view|info|search|outdated|audit)/i,
	/^\s*yarn\s+(list|info|why|audit)/i,
	/^\s*pnpm\s+(list|view|info|search|outdated|audit)/i,
	/^\s*node\s+--version/i,
	/^\s*python\s+--version/i,
	/^\s*curl\s/i,
	/^\s*wget\s+-O\s*-/i,
	/^\s*jq\b/,
	/^\s*sed\s+-n/i,
	/^\s*awk\b/,
	/^\s*rg\b/,
	/^\s*fd\b/,
	/^\s*bat\b/,
	/^\s*eza\b/,
];

const PlanAskUserSchema = Type.Object({
	question: Type.String({ description: "Question to ask the user" }),
	kind: Type.Optional(
		StringEnum(["confirm", "select", "input", "editor"] as const, {
			description: "Dialog type. Defaults to input unless options are provided, then select.",
		}),
	),
	options: Type.Optional(Type.Array(Type.String(), { description: "Options for select dialogs" })),
});

const PlanDraftTaskSchema = Type.Object({
	id: Type.Optional(Type.String()),
	title: Type.String(),
	description: Type.String(),
	dependsOn: Type.Optional(Type.Array(Type.String())),
	agent: Type.Optional(Type.String()),
	modelPreset: Type.Optional(Type.String()),
	review: Type.Optional(Type.Boolean()),
	validation: Type.Optional(Type.String()),
});

const PlanSubmitDraftSchema = Type.Object({
	title: Type.String({ description: "Plan title" }),
	summary: Type.Optional(Type.String({ description: "Short plan summary" })),
	markdown: Type.String({ description: "Complete human-readable plan markdown" }),
	tasks: Type.Array(PlanDraftTaskSchema, { description: "Executable task list extracted from the plan" }),
});

const EmptySchema = Type.Object({});

const PlanStartTaskSchema = Type.Object({
	taskId: Type.String({ description: "Task id from the approved plan" }),
	agent: Type.Optional(Type.String({ description: "Override agent name for this task" })),
	modelPreset: Type.Optional(Type.String({ description: "Override model preset for this task" })),
});

const PlanRecordTaskResultSchema = Type.Object({
	taskId: Type.String({ description: "Task id from the approved plan" }),
	status: StringEnum(["complete", "failed", "blocked"] as const, { description: "Task result status" }),
	summary: Type.String({ description: "Short result summary" }),
	validation: Type.Optional(Type.String({ description: "Validation performed and result" })),
	outputPath: Type.Optional(Type.String({ description: "Optional path to detailed output" })),
});

function isSafeCommand(command: string): boolean {
	return !DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(command)) && SAFE_PATTERNS.some((pattern) => pattern.test(command));
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}

function slugify(input: string): string {
	const slug = input
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 72);
	return slug || "plan";
}

function toRelative(cwd: string, absolutePath: string): string {
	return path.relative(cwd, absolutePath).split(path.sep).join("/");
}

function planRoot(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "plans");
}

function planDir(cwd: string, planId: string): string {
	return path.join(planRoot(cwd), planId);
}

async function readTextIfExists(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

async function writeTextQueued(filePath: string, content: string): Promise<void> {
	await withFileMutationQueue(filePath, async () => {
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, content, "utf8");
	});
}

async function loadPlan(cwd: string, planId: string): Promise<PlanFile | undefined> {
	const content = await readTextIfExists(path.join(planDir(cwd, planId), "plan.json"));
	if (!content.trim()) return undefined;
	return JSON.parse(content) as PlanFile;
}

async function savePlan(cwd: string, plan: PlanFile): Promise<void> {
	plan.updatedAt = new Date().toISOString();
	await writeTextQueued(path.join(planDir(cwd, plan.id), "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
}

async function createPlan(cwd: string, goal: string): Promise<PlanFile> {
	await mkdir(planRoot(cwd), { recursive: true });
	const baseSlug = slugify(goal);
	let id = baseSlug;
	let index = 2;
	while (existsSync(planDir(cwd, id))) {
		id = `${baseSlug}-${index}`;
		index += 1;
	}

	const now = new Date().toISOString();
	const dir = planDir(cwd, id);
	const emptyDraftPath = path.join(dir, "drafts", "empty.md");
	const descriptionPath = path.join(dir, "description.md");
	const plan: PlanFile = {
		id,
		goal,
		status: "planning",
		version: 0,
		createdAt: now,
		updatedAt: now,
		approvedPath: null,
		tasks: [],
	};

	await mkdir(path.join(dir, "drafts"), { recursive: true });
	await mkdir(path.join(dir, "reviews"), { recursive: true });
	await writeTextQueued(emptyDraftPath, "");
	await writeTextQueued(descriptionPath, `# Plan review\n\nGoal: ${goal}\n\nReview the proposed plan. Add annotations for anything that should change, needs clarification, is risky, or is missing. If you leave no annotations, the plan is considered approved.\n`);
	await savePlan(cwd, plan);
	return plan;
}

function normalizeTasks(tasks: Array<Record<string, unknown>>): PlanTask[] {
	return tasks.map((task, index) => {
		const id = typeof task.id === "string" && task.id.trim() ? task.id.trim() : `task-${index + 1}`;
		return {
			id,
			title: String(task.title ?? `Task ${index + 1}`).trim(),
			description: String(task.description ?? "").trim(),
			status: "pending",
			dependsOn: Array.isArray(task.dependsOn) ? task.dependsOn.map(String).filter(Boolean) : [],
			agent: typeof task.agent === "string" && task.agent.trim() ? task.agent.trim() : "worker",
			modelPreset: typeof task.modelPreset === "string" && task.modelPreset.trim() ? task.modelPreset.trim() : "default",
			review: typeof task.review === "boolean" ? task.review : false,
			validation: typeof task.validation === "string" && task.validation.trim() ? task.validation.trim() : undefined,
		};
	});
}

async function addPlansToGitignore(ctx: ExtensionContext, state: RuntimeState, persist: () => void): Promise<void> {
	if (state.gitignorePrompted) return;
	const gitignorePath = path.join(ctx.cwd, ".gitignore");
	const content = await readTextIfExists(gitignorePath);
	if (content.split(/\r?\n/).some((line) => line.trim() === `${CONFIG_DIR_NAME}/plans/` || line.trim() === `${CONFIG_DIR_NAME}/plans`)) return;

	state.gitignorePrompted = true;
	persist();
	if (!ctx.hasUI) return;

	const shouldAdd = await ctx.ui.confirm("Ignore local plan artifacts?", `Add ${CONFIG_DIR_NAME}/plans/ to .gitignore?`);
	if (!shouldAdd) return;

	const prefix = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
	const entry = `${prefix}\n# Local Pi planning artifacts\n${CONFIG_DIR_NAME}/plans/\n`;
	await writeTextQueued(gitignorePath, `${content}${entry}`);
	ctx.ui.notify(`Added ${CONFIG_DIR_NAME}/plans/ to .gitignore`, "info");
}

async function runRevdiff(ctx: ExtensionContext, oldPath: string, newPath: string, annotationsPath: string, descriptionPath: string): Promise<ReviewResult> {
	await mkdir(path.dirname(annotationsPath), { recursive: true });
	await rm(annotationsPath, { force: true });

	if (ctx.mode !== "tui") {
		throw new Error("Revdiff review requires interactive TUI mode.");
	}

	const args = [
		"--compare-old",
		oldPath,
		"--compare-new",
		newPath,
		"--output",
		annotationsPath,
		"--exit-code-on-annotations",
		"--wrap",
		"--word-diff",
		"--description-file",
		descriptionPath,
	];

	const exitCode = await ctx.ui.custom<number | null>((tui, _theme, _keybindings, done) => {
		tui.stop();
		process.stdout.write("\x1b[2J\x1b[H");
		const result = spawnSync("revdiff", args, {
			cwd: ctx.cwd,
			stdio: "inherit",
			env: process.env,
		});
		tui.start();
		tui.requestRender(true);
		done(result.status ?? 1);
		return { render: () => [], invalidate: () => {} };
	});

	const annotations = (await readTextIfExists(annotationsPath)).trim();
	return { exitCode: exitCode ?? 1, annotations, annotationsPath };
}

function reviewPaths(cwd: string, plan: PlanFile): { oldPath: string; newPath: string; annotationsPath: string; descriptionPath: string } {
	const dir = planDir(cwd, plan.id);
	const oldVersion = Math.max(0, plan.version - 1);
	return {
		oldPath: oldVersion === 0 ? path.join(dir, "drafts", "empty.md") : path.join(dir, "drafts", `draft-v${oldVersion}.md`),
		newPath: path.join(dir, "drafts", `draft-v${plan.version}.md`),
		annotationsPath: path.join(dir, "reviews", `review-v${plan.version}.md`),
		descriptionPath: path.join(dir, "description.md"),
	};
}

async function updateStatus(ctx: ExtensionContext, state: RuntimeState, plan?: PlanFile): Promise<void> {
	if (state.status === "idle" || state.status === "aborted") {
		ctx.ui.setStatus("plan", undefined);
		ctx.ui.setWidget("plan", undefined);
		return;
	}

	const loaded = plan ?? (state.activePlanId ? await loadPlan(ctx.cwd, state.activePlanId) : undefined);
	const label = loaded ? `${state.status}: ${loaded.id}` : state.status;
	const color = state.status === "approved" || state.status === "complete" ? "success" : state.status === "revising" || state.status === "blocked" ? "warning" : "accent";
	ctx.ui.setStatus("plan", ctx.ui.theme.fg(color, `plan ${label}`));

	if (!loaded) return;
	const lines = [
		ctx.ui.theme.fg("accent", `Plan: ${loaded.id}`),
		ctx.ui.theme.fg("muted", `Status: ${loaded.status}`),
		ctx.ui.theme.fg("muted", `Draft: v${loaded.version}`),
		ctx.ui.theme.fg("muted", `Tasks: ${loaded.tasks.length}`),
	];
	ctx.ui.setWidget("plan", lines);
}

function withoutExtensionTools(toolNames: string[]): string[] {
	return toolNames.filter((tool) => !EXTENSION_TOOL_SET.has(tool));
}

function disablePlanTools(pi: ExtensionAPI): void {
	pi.setActiveTools(withoutExtensionTools(pi.getActiveTools()));
}

function enablePlanTools(pi: ExtensionAPI, state: RuntimeState): void {
	if (!state.toolsBeforePlanMode) {
		state.toolsBeforePlanMode = withoutExtensionTools(pi.getActiveTools());
	}
	pi.setActiveTools(unique([...state.toolsBeforePlanMode.filter((tool) => !MUTATION_TOOLS.has(tool)), ...PLANNING_TOOLS]));
}

function enableExecutionTools(pi: ExtensionAPI, state: RuntimeState): void {
	if (!state.toolsBeforePlanMode) {
		state.toolsBeforePlanMode = withoutExtensionTools(pi.getActiveTools());
	}
	pi.setActiveTools(unique([...state.toolsBeforePlanMode, ...EXECUTION_EXTENSION_TOOLS]));
}

function restoreTools(pi: ExtensionAPI, state: RuntimeState): void {
	if (!state.toolsBeforePlanMode) {
		disablePlanTools(pi);
		return;
	}
	pi.setActiveTools(withoutExtensionTools(state.toolsBeforePlanMode));
	state.toolsBeforePlanMode = undefined;
}

function buildPlanPrompt(goal: string, plan: PlanFile): string {
	return `Start a planning session for this goal:\n\n${goal}\n\nYou are in plan mode. Explore the project read-only, ask clarifying questions when useful with plan_ask_user, then submit a reviewable plan with plan_submit_draft.\n\nPlan artifact directory: ${CONFIG_DIR_NAME}/plans/${plan.id}\n\nThe plan must include a concrete task list. Do not modify application code while planning.`;
}

function getTask(plan: PlanFile, taskId: string): PlanTask | undefined {
	return plan.tasks.find((task) => task.id === taskId);
}

function getNextExecutableTask(plan: PlanFile): PlanTask | undefined {
	return plan.tasks.find((task) => {
		if (task.status !== "pending" && task.status !== "failed" && task.status !== "blocked") return false;
		return task.dependsOn.every((dependencyId) => getTask(plan, dependencyId)?.status === "complete");
	});
}

function hasIncompleteDependencies(plan: PlanFile, task: PlanTask): string[] {
	return task.dependsOn.filter((dependencyId) => getTask(plan, dependencyId)?.status !== "complete");
}

function buildTaskPrompt(plan: PlanFile, task: PlanTask, agent: string, modelPreset: string): string {
	const dependencies = task.dependsOn.length > 0 ? task.dependsOn.join(", ") : "none";
	return `Execute approved plan task ${task.id}.\n\nPlan: ${CONFIG_DIR_NAME}/plans/${plan.id}/approved.md\nGoal: ${plan.goal}\n\nTask title: ${task.title}\nTask description:\n${task.description}\n\nDependencies: ${dependencies}\nAgent: ${agent}\nModel preset: ${modelPreset}\n${task.validation ? `\nValidation expected:\n${task.validation}\n` : ""}\nConstraints:\n- Follow the approved plan.\n- Do not broaden scope beyond this task.\n- If blocked or unsure, stop and report the blocker.\n- When finished, summarize changes and validation so the parent agent can call plan_record_task_result.`;
}

function isSubagentAvailable(pi: ExtensionAPI): boolean {
	return pi.getAllTools().some((tool) => tool.name === "subagent");
}

export default function planExtension(pi: ExtensionAPI): void {
	const state: RuntimeState = { status: "idle" };

	function persist(): void {
		pi.appendEntry(STATE_ENTRY_TYPE, { ...state });
	}

	async function leavePlanMode(ctx: ExtensionContext, markDraftAborted: boolean): Promise<void> {
		if (state.activePlanId && markDraftAborted) {
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (plan && ["planning", "reviewing", "revising"].includes(plan.status)) {
				plan.status = "aborted";
				await savePlan(ctx.cwd, plan);
			}
		}
		state.status = markDraftAborted ? "aborted" : "idle";
		restoreTools(pi, state);
		persist();
		await updateStatus(ctx, state);
		ctx.ui.notify(markDraftAborted ? "Plan mode aborted. Normal tools restored." : "Left plan mode. Normal tools restored. Plan metadata unchanged.", "info");
	}

	pi.registerCommand("plan", {
		description: "Start a local read-only planning session",
		handler: async (args, ctx) => {
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /plan <goal>", "warning");
				return;
			}

			if (state.activePlanId && !["idle", "approved", "aborted"].includes(state.status) && ctx.hasUI) {
				const choice = await ctx.ui.select("An active plan already exists. What now?", [
					"Resume existing plan",
					"Abort existing and start new",
					"Cancel",
				]);
				if (choice === "Cancel" || !choice) return;
				if (choice === "Resume existing plan") {
					enablePlanTools(pi, state);
					await updateStatus(ctx, state);
					persist();
					pi.sendUserMessage(`Resume planning for ${CONFIG_DIR_NAME}/plans/${state.activePlanId}. Continue research or submit a revised draft when ready.`);
					return;
				}
			}

			const plan = await createPlan(ctx.cwd, goal);
			state.activePlanId = plan.id;
			state.status = "planning";
			enablePlanTools(pi, state);
			persist();
			await addPlansToGitignore(ctx, state, persist);
			await updateStatus(ctx, state, plan);
			ctx.ui.notify(`Plan mode enabled: ${CONFIG_DIR_NAME}/plans/${plan.id}`, "info");
			pi.sendUserMessage(buildPlanPrompt(goal, plan));
		},
	});

	pi.registerCommand("plan-status", {
		description: "Show active local plan status",
		handler: async (_args, ctx) => {
			if (!state.activePlanId) {
				ctx.ui.notify("No active plan.", "info");
				return;
			}
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (!plan) {
				ctx.ui.notify(`Active plan metadata not found: ${state.activePlanId}`, "error");
				return;
			}
			const tasks = plan.tasks.map((task) => `- ${task.id}: ${task.title} [${task.status}]`).join("\n");
			ctx.ui.notify(
				[
					`Plan: ${plan.id}`,
					`Goal: ${plan.goal}`,
					`Status: ${plan.status}`,
					`Version: ${plan.version}`,
					`Draft: ${plan.draftPath ?? "none"}`,
					`Approved: ${plan.approvedPath ?? "no"}`,
					`Tasks:\n${tasks || "none"}`,
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("plan-exit", {
		description: "Leave plan mode and restore normal tools without changing plan metadata",
		handler: async (_args, ctx) => {
			await leavePlanMode(ctx, false);
		},
	});

	pi.registerCommand("plan-abort", {
		description: "Abort an active unapproved planning draft and restore normal tools",
		handler: async (_args, ctx) => {
			await leavePlanMode(ctx, true);
		},
	});

	pi.registerCommand("plan-review", {
		description: "Review the latest active plan draft with revdiff",
		handler: async (_args, ctx) => {
			if (!state.activePlanId) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (!plan || plan.version < 1) {
				ctx.ui.notify("No draft to review yet.", "warning");
				return;
			}
			const paths = reviewPaths(ctx.cwd, plan);
			const result = await runRevdiff(ctx, paths.oldPath, paths.newPath, paths.annotationsPath, paths.descriptionPath);
			if (result.annotations.trim()) {
				plan.status = "revising";
				state.status = "revising";
				await savePlan(ctx.cwd, plan);
				persist();
				await updateStatus(ctx, state, plan);
				pi.sendUserMessage(`I reviewed ${plan.draftPath} and left these annotations. Revise the plan and submit a new draft.\n\n${result.annotations}`);
				return;
			}
			ctx.ui.notify("No annotations found. Plan remains clean for approval.", "info");
		},
	});

	pi.registerCommand("plan-execute", {
		description: "Start sequential execution for the approved active plan",
		handler: async (_args, ctx) => {
			if (!state.activePlanId) {
				ctx.ui.notify("No active plan.", "warning");
				return;
			}
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (!plan || (plan.status !== "approved" && plan.status !== "executing" && plan.status !== "blocked")) {
				ctx.ui.notify("The active plan is not approved yet.", "warning");
				return;
			}
			if (!isSubagentAvailable(pi)) {
				ctx.ui.notify("The subagent tool is not loaded. Execution can still be guided manually, but automated delegation is unavailable.", "warning");
			}
			plan.status = "executing";
			state.status = "executing";
			enableExecutionTools(pi, state);
			await savePlan(ctx.cwd, plan);
			persist();
			await updateStatus(ctx, state, plan);
			pi.sendUserMessage(`Start executing approved plan ${CONFIG_DIR_NAME}/plans/${plan.id}. Call plan_get_status, then plan_start_task for the next executable task, then use the subagent tool if available. After each task, call plan_record_task_result.`);
		},
	});

	pi.registerTool({
		name: "plan_ask_user",
		label: "Plan Ask User",
		description: "Ask the user a clarifying question during local plan mode. Supports confirm, select, input, and editor dialogs.",
		parameters: PlanAskUserSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) return { content: [{ type: "text", text: "No UI is available to ask the user." }], details: { answer: null } };
			const kind = params.kind ?? (params.options?.length ? "select" : "input");
			let answer: string | boolean | undefined;
			if (kind === "confirm") answer = await ctx.ui.confirm("Plan question", params.question);
			else if (kind === "select") answer = await ctx.ui.select(params.question, params.options?.length ? params.options : ["Yes", "No"]);
			else if (kind === "editor") answer = await ctx.ui.editor(params.question, "");
			else answer = await ctx.ui.input(params.question, "");
			return {
				content: [{ type: "text", text: answer === undefined ? "User did not provide an answer." : `User answer: ${String(answer)}` }],
				details: { answer: answer ?? null },
			};
		},
	});

	pi.registerTool({
		name: "plan_submit_draft",
		label: "Plan Submit Draft",
		description: "Submit a local plan draft for Revdiff review. Only writes under the active .pi/plans/<id> directory.",
		parameters: PlanSubmitDraftSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.activePlanId) throw new Error("No active plan. Start one with /plan <goal>.");
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (!plan) throw new Error(`Active plan metadata not found: ${state.activePlanId}`);
			if (!["planning", "reviewing", "revising"].includes(plan.status)) {
				throw new Error(`Plan is ${plan.status}; drafts can only be submitted while planning or revising.`);
			}

			plan.version += 1;
			plan.status = "reviewing";
			plan.tasks = normalizeTasks(params.tasks as Array<Record<string, unknown>>);
			const draftPath = path.join(planDir(ctx.cwd, plan.id), "drafts", `draft-v${plan.version}.md`);
			const relativeDraftPath = toRelative(ctx.cwd, draftPath);
			plan.draftPath = relativeDraftPath;
			state.status = "reviewing";
			persist();

			const taskMarkdown = plan.tasks
				.map((task) => `- ${task.id}: ${task.title}\n  - Agent: ${task.agent}\n  - Model preset: ${task.modelPreset}\n  - Review: ${task.review ? "yes" : "no"}${task.validation ? `\n  - Validation: ${task.validation}` : ""}`)
				.join("\n");
			const draft = `${params.markdown.trim()}\n\n---\n\n## Execution Tasks\n\n${taskMarkdown || "No tasks provided."}\n`;
			await writeTextQueued(draftPath, draft);
			await savePlan(ctx.cwd, plan);
			await updateStatus(ctx, state, plan);

			const paths = reviewPaths(ctx.cwd, plan);
			const result = await runRevdiff(ctx, paths.oldPath, paths.newPath, paths.annotationsPath, paths.descriptionPath);
			const relativeAnnotationsPath = toRelative(ctx.cwd, paths.annotationsPath);

			if (result.annotations.trim()) {
				plan.status = "revising";
				state.status = "revising";
				await savePlan(ctx.cwd, plan);
				persist();
				await updateStatus(ctx, state, plan);
				return {
					content: [
						{
							type: "text",
							text: `Plan draft v${plan.version} needs revision. Address every annotation, ask the user if you disagree or need clarification, then submit a new draft.\n\nAnnotations (${relativeAnnotationsPath}):\n\n${result.annotations}`,
						},
					],
					details: { status: "needs_revision", annotationsPath: relativeAnnotationsPath, annotations: result.annotations },
				};
			}

			if (result.exitCode !== 0 && result.exitCode !== 10) {
				throw new Error(`revdiff exited with code ${result.exitCode} and produced no annotations.`);
			}

			const approvedPath = path.join(planDir(ctx.cwd, plan.id), "approved.md");
			await writeTextQueued(approvedPath, draft);
			plan.status = "approved";
			plan.approvedAt = new Date().toISOString();
			plan.approvedPath = toRelative(ctx.cwd, approvedPath);

			let startExecution = false;
			if (ctx.hasUI) {
				startExecution = await ctx.ui.confirm("Plan approved", "No annotations were left. Start execution now?");
			}

			if (startExecution) {
				plan.status = "executing";
				state.status = "executing";
				enableExecutionTools(pi, state);
			} else {
				state.status = "approved";
				restoreTools(pi, state);
			}
			await savePlan(ctx.cwd, plan);
			persist();
			await updateStatus(ctx, state, plan);

			return {
				content: [
					{
						type: "text",
						text: startExecution
							? `Plan approved at ${plan.approvedPath}. The user wants to start execution. Call plan_get_status, then plan_start_task for the next executable task, then use the subagent tool if available. After each task, call plan_record_task_result.`
							: `Plan approved at ${plan.approvedPath}. The user chose not to start execution now.`,
					},
				],
				details: { status: plan.status, approvedPath: plan.approvedPath, startExecution },
			};
		},
	});

	pi.registerTool({
		name: "plan_get_status",
		label: "Plan Get Status",
		description: "Get the active local plan status, tasks, and next executable task.",
		parameters: EmptySchema,
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			if (!state.activePlanId) {
				return { content: [{ type: "text", text: "No active plan." }], details: { active: false } };
			}
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (!plan) throw new Error(`Active plan metadata not found: ${state.activePlanId}`);
			const nextTask = getNextExecutableTask(plan);
			const taskLines = plan.tasks.map((task) => `- ${task.id}: ${task.title} [${task.status}]`).join("\n");
			return {
				content: [
					{
						type: "text",
						text: [
							`Plan: ${plan.id}`,
							`Goal: ${plan.goal}`,
							`Status: ${plan.status}`,
							`Approved path: ${plan.approvedPath ?? "none"}`,
							`Next executable task: ${nextTask ? `${nextTask.id} - ${nextTask.title}` : "none"}`,
							`Tasks:\n${taskLines || "none"}`,
						].join("\n"),
					},
				],
				details: { active: true, plan, nextTask: nextTask ?? null, subagentAvailable: isSubagentAvailable(pi) },
			};
		},
	});

	pi.registerTool({
		name: "plan_start_task",
		label: "Plan Start Task",
		description: "Mark an approved plan task as running and return the exact task prompt to delegate to a subagent.",
		parameters: PlanStartTaskSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.activePlanId) throw new Error("No active plan.");
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (!plan) throw new Error(`Active plan metadata not found: ${state.activePlanId}`);
			if (plan.status !== "approved" && plan.status !== "executing" && plan.status !== "blocked") {
				throw new Error(`Plan is ${plan.status}; tasks can only start after approval.`);
			}
			const task = getTask(plan, params.taskId);
			if (!task) throw new Error(`Unknown task: ${params.taskId}`);
			const incompleteDependencies = hasIncompleteDependencies(plan, task);
			if (incompleteDependencies.length > 0) {
				throw new Error(`Task ${task.id} has incomplete dependencies: ${incompleteDependencies.join(", ")}`);
			}
			const alreadyRunning = plan.tasks.find((candidate) => candidate.status === "running" && candidate.id !== task.id);
			if (alreadyRunning) throw new Error(`Task ${alreadyRunning.id} is already running. Record its result before starting another task.`);

			const agent = params.agent ?? task.agent;
			const modelPreset = params.modelPreset ?? task.modelPreset;
			task.status = "running";
			plan.status = "executing";
			state.status = "executing";
			enableExecutionTools(pi, state);
			await savePlan(ctx.cwd, plan);
			persist();
			await updateStatus(ctx, state, plan);

			const taskPrompt = buildTaskPrompt(plan, task, agent, modelPreset);
			const subagentHint = isSubagentAvailable(pi)
				? `Call the subagent tool with { agent: "${agent}", task: <task prompt>, agentScope: "package", confirmProjectAgents: false }. Bundled pi-plan agent definitions encode the default model/thinking presets. Requested model preset: "${modelPreset}".`
				: "The subagent tool is not loaded; execute this task directly or ask the user how to proceed.";
			return {
				content: [
					{
						type: "text",
						text: `Task ${task.id} is now running.\n\n${subagentHint}\n\nTask prompt:\n\n${taskPrompt}`,
					},
				],
				details: { planId: plan.id, task, agent, modelPreset, taskPrompt, subagentAvailable: isSubagentAvailable(pi) },
			};
		},
	});

	pi.registerTool({
		name: "plan_record_task_result",
		label: "Plan Record Task Result",
		description: "Record the result of a running plan task and advance, block, or complete the active plan.",
		parameters: PlanRecordTaskResultSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!state.activePlanId) throw new Error("No active plan.");
			const plan = await loadPlan(ctx.cwd, state.activePlanId);
			if (!plan) throw new Error(`Active plan metadata not found: ${state.activePlanId}`);
			const task = getTask(plan, params.taskId);
			if (!task) throw new Error(`Unknown task: ${params.taskId}`);

			task.status = params.status;
			const logPath = path.join(planDir(ctx.cwd, plan.id), "execution-log.md");
			const existingLog = await readTextIfExists(logPath);
			const logEntry = [
				`## ${new Date().toISOString()} - ${task.id} - ${params.status}`,
				``,
				`### Summary`,
				params.summary,
				params.validation ? `\n### Validation\n${params.validation}` : "",
				params.outputPath ? `\n### Output\n${params.outputPath}` : "",
				``,
			].join("\n");
			await writeTextQueued(logPath, `${existingLog}${existingLog.endsWith("\n") || existingLog.length === 0 ? "" : "\n"}${logEntry}`);

			let userDecision: string | undefined;
			let reviewerRequested = false;
			if (params.status === "failed" || params.status === "blocked") {
				plan.status = "blocked";
				state.status = "blocked";
				if (ctx.hasUI) {
					userDecision = await ctx.ui.select(`Task ${task.id} ${params.status}. What now?`, [
						"Retry same task",
						"Retry with hard preset",
						"Revise plan",
						"Stop execution",
					]);
				}
			} else if (plan.tasks.every((candidate) => candidate.status === "complete" || candidate.status === "skipped")) {
				plan.status = "complete";
				state.status = "complete";
				restoreTools(pi, state);
			} else {
				plan.status = "executing";
				state.status = "executing";
				enableExecutionTools(pi, state);
				if (task.review && ctx.hasUI) {
					reviewerRequested = await ctx.ui.confirm("Reviewer hook", `Task ${task.id} is complete. Run reviewer subagent now?`);
				}
			}

			await savePlan(ctx.cwd, plan);
			persist();
			await updateStatus(ctx, state, plan);

			const nextTask = getNextExecutableTask(plan);
			let guidance = "";
			if (userDecision === "Retry same task") {
				task.status = "pending";
				plan.status = "executing";
				state.status = "executing";
				enableExecutionTools(pi, state);
				await savePlan(ctx.cwd, plan);
				persist();
				await updateStatus(ctx, state, plan);
				guidance = `Retry task ${task.id}. Call plan_start_task with taskId "${task.id}".`;
			} else if (userDecision === "Retry with hard preset") {
				task.status = "pending";
				plan.status = "executing";
				state.status = "executing";
				enableExecutionTools(pi, state);
				await savePlan(ctx.cwd, plan);
				persist();
				await updateStatus(ctx, state, plan);
				guidance = `Retry task ${task.id}. Call plan_start_task with taskId "${task.id}" and modelPreset "hard".`;
			} else if (userDecision === "Revise plan") {
				guidance = "Ask the user what should change, then return to planning/revision manually. Full plan revision tooling will be added later.";
			} else if (userDecision === "Stop execution") {
				guidance = "Stop execution and wait for the user's next instruction.";
			} else if (reviewerRequested) {
				guidance = `Run reviewer subagent for task ${task.id}. After review, decide whether to continue with ${nextTask ? `task ${nextTask.id}` : "the next task"} or ask the user.`;
			} else if (plan.status === "complete") {
				guidance = `All tasks are complete. Execution log: ${toRelative(ctx.cwd, logPath)}`;
			} else if (nextTask) {
				guidance = `Next executable task: ${nextTask.id} - ${nextTask.title}. Call plan_start_task when ready.`;
			} else {
				guidance = "No executable task is currently available. Check dependencies or ask the user.";
			}

			return {
				content: [{ type: "text", text: `Recorded task ${task.id} as ${params.status}.\n\n${guidance}` }],
				details: { plan, task, nextTask: nextTask ?? null, userDecision, reviewerRequested, executionLogPath: toRelative(ctx.cwd, logPath) },
			};
		},
	});

	pi.on("tool_call", async (event) => {
		if (!["planning", "reviewing", "revising"].includes(state.status)) return;
		if (MUTATION_TOOLS.has(event.toolName)) {
			return { block: true, reason: "Plan mode blocks built-in mutation tools. Use plan_submit_draft for plan artifacts only." };
		}
		if (isToolCallEventType("bash", event) && !isSafeCommand(event.input.command)) {
			return { block: true, reason: `Plan mode blocks non-read-only bash commands. Command: ${event.input.command}` };
		}
	});

	pi.on("before_agent_start", async () => {
		if (!["planning", "reviewing", "revising", "executing", "blocked"].includes(state.status) || !state.activePlanId) return;
		if (["executing", "blocked"].includes(state.status)) {
			return {
				message: {
					customType: "plan-execution-context",
					content: `[LOCAL PLAN EXECUTION ACTIVE]\nActive plan: ${CONFIG_DIR_NAME}/plans/${state.activePlanId}\n\nUse plan_get_status to inspect tasks. Use plan_start_task before delegating or executing a task. Use the subagent tool when available. After each task, call plan_record_task_result. If a task fails or is blocked, ask the user what to do.`,
					display: false,
				},
			};
		}
		return {
			message: {
				customType: "plan-mode-context",
				content: `[LOCAL PLAN MODE ACTIVE]\nActive plan: ${CONFIG_DIR_NAME}/plans/${state.activePlanId}\n\nRestrictions:\n- Do not modify application code.\n- Built-in edit/write are blocked.\n- Bash is restricted to read-only exploration commands.\n- Use plan_ask_user for clarifying questions.\n- Use plan_submit_draft when the plan is ready for Revdiff review.\n\nThe submitted draft must be concrete, task-oriented, and scoped to the user's goal.`,
				display: false,
			},
		};
	});

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const latest = entries
			.filter((entry: { type: string; customType?: string }) => entry.type === "custom" && entry.customType === STATE_ENTRY_TYPE)
			.pop() as { data?: RuntimeState } | undefined;
		if (latest?.data) Object.assign(state, latest.data);
		if (["planning", "reviewing", "revising"].includes(state.status)) {
			enablePlanTools(pi, state);
			persist();
		} else if (["executing", "blocked"].includes(state.status)) {
			enableExecutionTools(pi, state);
			persist();
		} else {
			disablePlanTools(pi);
		}
		await updateStatus(ctx, state);
	});
}
