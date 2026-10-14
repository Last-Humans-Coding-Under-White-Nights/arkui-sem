// opencode v1 plugin. tool.execute.after: append new findings to .ets edit results.
// session.idle: one follow-up while confident findings remain (once per finding set, ≤ 3 per session).
// Tools: arkui_check, arkui_facts. Session state lives in memory in the long-running opencode server.
import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { type Plugin, tool } from "@opencode-ai/plugin";
import { absolute, editedFiles, etsFiles, NaiveExtractor } from "./analysis.js";
import { cachePath, loadSettings } from "./config.js";
import { checkFiles, type Finding, formatForAgent } from "./engine.js";
import { createBackend, type SystemOneBackend } from "./judge.js";

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "patch", "apply_patch"]);
const MAX_GATE_FOLLOWUPS = 3;

interface SessionState {
  touched: Set<string>;
  reported: Set<string>;
  lastGateKey: string;
  followups: number;
}

export const ArkuiSemPlugin: Plugin = async ({ client, directory }, options) => {
  const settings = loadSettings(options, directory);
  const sessions = new Map<string, SessionState>();
  let backend: SystemOneBackend | undefined;

  const log = (level: "debug" | "info" | "warn" | "error", message: string) =>
    client.app.log({ body: { service: "arkui-sem", level, message } }).catch(() => undefined);

  const session = (id: string): SessionState => {
    let s = sessions.get(id);
    if (!s) sessions.set(id, (s = { touched: new Set(), reported: new Set(), lastGateKey: "", followups: 0 }));
    return s;
  };

  const run = async (files: string[]): Promise<Finding[]> => {
    backend ??= await createBackend(settings.backend, settings.credentials);
    const { findings, errors } = await checkFiles(files, {
      backend,
      thresholds: settings.thresholds,
      cachePath: cachePath(settings),
      judgeTimeoutMs: settings.judgeTimeoutMs,
    });
    if (errors.length) await log("warn", errors.join("; "));
    return findings;
  };

  await log(
    "info",
    `loaded (backend=${settings.backend}, gate=${settings.gate}, config=${settings.sources.join(", ") || "none"})`,
  );
  for (const w of settings.warnings) await log("warn", w);

  return {
    "tool.execute.after": async (input, output) => {
      if (!EDIT_TOOLS.has(input.tool)) return;
      const files = editedFiles(input.args, directory).filter((f) => f.endsWith(".ets"));
      if (files.length === 0) return;
      try {
        const s = session(input.sessionID);
        files.forEach((f) => s.touched.add(f));
        const fresh = (await run(files)).filter((f) => !s.reported.has(f.fingerprint));
        fresh.forEach((f) => s.reported.add(f.fingerprint));
        if (fresh.length > 0) output.output = `${output.output}\n\n${formatForAgent(fresh, directory)}`;
      } catch (e) {
        // Never break the agent loop because the linter failed.
        await log("error", `post-edit check failed: ${(e as Error).message}`);
      }
    },

    event: async ({ event }) => {
      if (event.type !== "session.idle" || !settings.gate) return;
      const id = event.properties.sessionID;
      const s = sessions.get(id);
      if (!s || s.touched.size === 0) return;
      try {
        const confident = (await run([...s.touched])).filter((f) => f.band === "finding");
        const key = confident
          .map((f) => f.fingerprint)
          .sort()
          .join("|");
        if (confident.length === 0) {
          s.lastGateKey = "";
          return;
        }
        if (key === s.lastGateKey || s.followups >= MAX_GATE_FOLLOWUPS) {
          await log("info", `${confident.length} unresolved finding(s) in session ${id}; gate already used`);
          return;
        }
        s.followups++;
        s.lastGateKey = key;
        await client.session.promptAsync({
          path: { id },
          body: {
            parts: [
              {
                type: "text",
                text: `${formatForAgent(confident, directory)}\n\nBefore finishing: fix these, or if one is intentional, add the disable comment with a reason.`,
              },
            ],
          },
        });
      } catch (e) {
        await log("error", `end-of-turn gate failed: ${(e as Error).message}`);
      }
    },

    tool: {
      arkui_check: tool({
        description:
          "Check ArkTS/ArkUI .ets files for state-management and lifecycle defects: state that won't re-render the UI, nested mutation of unobserved classes, listeners and timers that are never released. Pass files or directories; defaults to the project.",
        args: {
          paths: tool.schema
            .array(tool.schema.string())
            .optional()
            .describe("Files or directories to check, relative to the project"),
        },
        async execute(args, ctx) {
          const files = (args.paths?.length ? args.paths : ["."]).flatMap((p) => etsFiles(absolute(p, ctx.directory)));
          const findings = await run(files);
          return formatForAgent(findings, ctx.directory) || `arkui-sem: no findings in ${files.length} .ets file(s).`;
        },
      }),

      arkui_facts: tool({
        description:
          "Show ArkUI state-ownership facts for one .ets file: each component's fields with decorators, where each is read in build() and where it is written (event handler, async callback, lifecycle), and listeners/timers with their release status. Use before changing state decorators or how data flows between components.",
        args: { file: tool.schema.string().describe("Path to a .ets file") },
        async execute(args, ctx) {
          const file = absolute(args.file, ctx.directory);
          const facts = new NaiveExtractor().extract(file, readFileSync(file, "utf8"));
          return JSON.stringify(
            {
              file: relative(ctx.directory, file),
              observedClasses: facts.observedClasses,
              components: facts.components.map((c) => ({
                name: c.name,
                line: c.line,
                stateManagement: c.version,
                fields: c.fields.map((f) => ({
                  name: f.name,
                  line: f.line,
                  decorators: f.decorators,
                  type: f.type ?? null,
                  readInBuildAt: f.readsInBuild,
                  writes: f.writes,
                })),
                resources: c.resources,
              })),
            },
            null,
            2,
          );
        },
      }),
    },
  };
};
