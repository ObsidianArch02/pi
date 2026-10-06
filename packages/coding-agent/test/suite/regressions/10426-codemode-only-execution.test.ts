import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolExposure } from "../../../src/core/extensions/types.ts";
import { createCodemodeExtension } from "../../../src/extensions/codemode/index.ts";
import { createToolSearchExtension } from "../../../src/extensions/tool-search/index.ts";
import { createHarness, getToolResult, type Harness, type HarnessOptions } from "../harness.ts";

describe("codemode-only execution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function setup(
		options: {
			mode?: "on" | "only";
			codemodeMode?: "on" | "only";
			includeToolSearch?: boolean;
			extensionFactories?: HarnessOptions["extensionFactories"];
		} = {},
	) {
		const executed: string[] = [];
		const registerTools = (pi: ExtensionAPI) => {
			const register = (name: string, exposure?: ToolExposure) => {
				pi.registerTool({
					name,
					label: name,
					description: `Record ${name} execution.`,
					parameters: Type.Object({ value: Type.String() }),
					...(exposure ? { exposure } : {}),
					execute: async (_id, { value }) => {
						executed.push(value);
						return { content: [{ type: "text", text: value }], details: {} };
					},
				});
			};
			register("direct_tool");
			register("codemode_tool", "codemode");
			register("deferred_tool", "deferred");
			pi.registerTool({
				name: "model_tool",
				label: "model_tool",
				description: "Orchestrate another tool.",
				parameters: Type.Object({ value: Type.String() }),
				exposure: "model-only",
				execute: async (_id, { value }, _signal, _onUpdate, ctx) => {
					const nested = await ctx.executeTool("direct_tool", { value });
					return { ...nested.result, isError: nested.isError };
				},
			});
		};
		const harness = await createHarness({
			settings: { codemode: { mode: options.mode ?? "only" } },
			initialActiveToolNames: ["codemode"],
			extensionFactories: [
				...(options.extensionFactories ?? []),
				createCodemodeExtension({ mode: options.codemodeMode }),
				...(options.includeToolSearch ? [createToolSearchExtension()] : []),
				registerTools,
			],
		});
		harnesses.push(harness);
		return { harness, executed };
	}

	// Regression #10426: hidden tools must not execute from a direct model call.
	it("blocks direct calls to ordinary extension tools and keeps script calls working", async () => {
		const { harness, executed } = await setup();
		harness.session.setActiveToolsByName(["codemode", "direct_tool"]);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
				return fauxAssistantMessage(fauxToolCall("direct_tool", { value: "direct" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call the hidden tool");

		expect(getToolResult(harness, "direct_tool").isError).toBe(true);
		expect(executed).toEqual([]);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: 'text(await tools.direct_tool({ value: "nested" }));' }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call it through codemode");

		expect(getToolResult(harness, "codemode").isError).toBe(false);
		expect(executed).toEqual(["nested"]);
	});

	it.each(["codemode_tool", "deferred_tool"])("blocks explicitly activated %s", async (name) => {
		const { harness, executed } = await setup();
		harness.session.setActiveToolsByName(["codemode", "codemode_tool", "deferred_tool"]);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode"]);
				return fauxAssistantMessage(fauxToolCall(name, { value: "direct" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call the activated codemode tool");

		expect(getToolResult(harness, name).isError).toBe(true);
		expect(executed).toEqual([]);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", {
					code: 'await tools.codemode_tool({ value: "one" }); await tools.deferred_tool({ value: "two" });',
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call both through codemode");

		expect(getToolResult(harness, "codemode").isError).toBe(false);
		expect(executed).toEqual(["one", "two"]);
	});

	it("allows model-only orchestrators and their nested calls", async () => {
		const { harness, executed } = await setup();
		harness.session.setActiveToolsByName(["codemode", "model_tool", "direct_tool"]);
		harness.setResponses([
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode", "model_tool"]);
				return fauxAssistantMessage(fauxToolCall("model_tool", { value: "nested" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run the orchestrator");

		expect(getToolResult(harness, "model_tool").isError).toBe(false);
		expect(executed).toEqual(["nested"]);
	});

	it("keeps direct model calls working in on mode", async () => {
		const { harness, executed } = await setup({ mode: "on" });
		harness.session.setActiveToolsByName(["codemode", "direct_tool"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("direct_tool", { value: "direct" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");

		expect(getToolResult(harness, "direct_tool").isError).toBe(false);
		expect(executed).toEqual(["direct"]);
	});

	it.each([
		{ mode: "only", codemodeMode: undefined },
		{ mode: "on", codemodeMode: "only" },
	] as const)("keeps tool_search-loaded tools behind codemode ($mode, override $codemodeMode)", async (options) => {
		const { harness, executed } = await setup({ ...options, includeToolSearch: true });
		harness.session.setActiveToolsByName(["codemode", "tool_search"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "deferred", limit: 1 }), { stopReason: "toolUse" }),
			(context) => {
				expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["codemode", "tool_search"]);
				return fauxAssistantMessage(fauxToolCall("deferred_tool", { value: "direct" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("discover then call");

		expect(getToolResult(harness, "deferred_tool").isError).toBe(true);
		expect(executed).toEqual([]);
		expect(getToolResult(harness, "tool_search").content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining("call them from a codemode script"),
		});

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: 'text(await tools.deferred_tool({ value: "nested" }));' }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("call it through codemode");

		expect(executed).toEqual(["nested"]);
	});

	it("blocks built-in writes without creating a file, and allows the same write from a script", async () => {
		const { harness } = await setup();
		harness.session.setActiveToolsByName(["codemode", "write"]);
		const path = join(harness.tempDir, "output.txt");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("write", { path, content: "direct" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write directly");
		expect(getToolResult(harness, "write").isError).toBe(true);
		expect(existsSync(path)).toBe(false);

		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("codemode", { code: `await tools.write(${JSON.stringify({ path, content: "nested" })});` }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("write through codemode");
		expect(getToolResult(harness, "codemode").isError).toBe(false);
		expect(readFileSync(path, "utf8")).toBe("nested");
	});

	it("allows direct calls when codemode is deactivated", async () => {
		const { harness, executed } = await setup();
		harness.session.setActiveToolsByName(["direct_tool"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("direct_tool", { value: "direct" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "direct_tool").isError).toBe(false);
		expect(executed).toEqual(["direct"]);
	});

	it("does not apply only mode to an unrelated replacement named codemode", async () => {
		const { harness, executed } = await setup({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "codemode",
						label: "Replacement",
						description: "An unrelated replacement",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			],
		});
		harness.session.setActiveToolsByName(["codemode", "direct_tool"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("direct_tool", { value: "direct" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "direct_tool").isError).toBe(false);
		expect(executed).toEqual(["direct"]);
	});

	it("still applies permission hooks to script calls", async () => {
		const { harness, executed } = await setup({
			extensionFactories: [
				(pi) => {
					pi.on("tool_call", (event) =>
						event.toolName === "direct_tool" ? { block: true, reason: "Permission denied" } : undefined,
					);
				},
			],
		});
		harness.session.setActiveToolsByName(["codemode", "direct_tool"]);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("codemode", { code: 'await tools.direct_tool({ value: "nested" });' }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("go");
		expect(getToolResult(harness, "codemode").isError).toBe(true);
		expect(executed).toEqual([]);
	});
});
