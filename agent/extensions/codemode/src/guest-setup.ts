/**
 * Source evaluated inside QuickJS before the guest program. Builds the only
 * globals a program sees: pi.*, π, process.env, print.
 * Everything here runs in the sandbox; the single escape is __codeModeHostCall.
 *
 * Argument normalization is defined as a closed factory so the host can reuse
 * the identical function (see normalizePiArgs below) — no drift between the
 * repair the guest applies and what the host would apply.
 */

// Closed factory: no module captures, no host capabilities. Its serialized body
// is evaluated inside QuickJS.
function createPiArgumentNormalizer() {
	const stringField: Record<string, string> = {
		bash: "command",
		read: "path",
		ls: "path",
		grep: "pattern",
		find: "pattern",
	};
	const aliases: Record<string, Record<string, string>> = {
		bash: {
			cmd: "command",
			shell: "command",
			script: "command",
			commandLine: "command",
			workdir: "cwd",
			directory: "cwd",
			workingDirectory: "cwd",
		},
		find: { query: "pattern", regex: "pattern", search: "pattern", glob: "pattern", max: "limit" },
		grep: {
			query: "pattern",
			regex: "pattern",
			search: "pattern",
			text: "pattern",
			caseInsensitive: "ignoreCase",
			max: "limit",
			ctx: "context",
		},
		read: {
			file: "path",
			file_path: "path",
			filePath: "path",
			filepath: "path",
			pathname: "path",
			absolutePath: "path",
			absolute_path: "path",
			target_file: "path",
			targetFile: "path",
			max: "limit",
			start: "offset",
		},
		ls: { dir: "path", folder: "path", directory: "path", file_path: "path", filePath: "path" },
		edit: {
			file: "path",
			file_path: "path",
			filePath: "path",
			filepath: "path",
			old: "oldText",
			old_string: "oldText",
			oldString: "oldText",
			old_str: "oldText",
			old_text: "oldText",
			new: "newText",
			new_string: "newText",
			newString: "newText",
			new_str: "newText",
			new_text: "newText",
			replacement: "newText",
		},
		write: {
			file: "path",
			file_path: "path",
			filePath: "path",
			contents: "content",
			body: "content",
			text: "content",
		},
	};
	const numericFields: Record<string, string[]> = {
		read: ["offset", "limit"],
		grep: ["limit", "context"],
		find: ["limit"],
		ls: ["limit"],
		bash: ["timeout"],
	};
	const optionalFields: Record<string, string[]> = {
		read: ["offset", "limit"],
		grep: ["path", "glob", "ignoreCase", "literal", "context", "limit"],
		find: ["path", "limit"],
		ls: ["path", "limit"],
		bash: ["timeout"],
	};

	return (name: string, args: any): unknown => {
		const primary = stringField[name];
		if (typeof args === "string" && primary) return { [primary]: args };
		if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
		let out = args;
		const copy = (): void => {
			if (out === args) out = { ...args };
		};
		// Models write timeoutMs for bash; Pi's schema takes seconds.
		if (name === "bash" && Object.hasOwn(out, "timeoutMs")) {
			copy();
			const ms = out.timeoutMs;
			if (!("timeout" in out) && ms !== null && ms !== undefined) {
				out.timeout = Number.isFinite(Number(ms)) ? Number(ms) / 1000 : ms;
			}
			delete out.timeoutMs;
		}
		const alias = aliases[name];
		if (alias) {
			for (const from in alias) {
				const to = alias[from]!;
				if (!Object.hasOwn(out, from)) continue;
				copy();
				if (!Object.hasOwn(out, to)) out[to] = out[from];
				delete out[from];
			}
		}
		for (const key of numericFields[name] ?? []) {
			const value = out[key];
			if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
				copy();
				out[key] = Number(value);
			}
		}
		// Explicit null/undefined on an optional field fails Pi's schema; dropping
		// it means "not provided", which is what the model meant.
		for (const key of optionalFields[name] ?? []) {
			if (!(key in out) || (out[key] !== null && out[key] !== undefined)) continue;
			copy();
			delete out[key];
		}
		// Aliases inside edits[] entries need the same repair as the top level:
		// edits: [{ old_string, new_string }] is a very common model output.
		if (name === "edit" && Array.isArray(out.edits) && alias) {
			let changed = false;
			const edits = out.edits.map((entry: any) => {
				if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return entry;
				let edit = entry;
				for (const from in alias) {
					const to = alias[from]!;
					if ((to !== "oldText" && to !== "newText") || !Object.hasOwn(edit, from)) continue;
					if (edit === entry) edit = { ...entry };
					if (!Object.hasOwn(edit, to)) edit[to] = edit[from];
					delete edit[from];
					changed = true;
				}
				return edit;
			});
			if (changed) {
				copy();
				out.edits = edits;
			}
		}
		// edit takes edits[]; a single flat {oldText,newText} is the common miss.
		if (name === "edit" && !Array.isArray(out.edits) && ("oldText" in out || "newText" in out)) {
			copy();
			out.edits = [{ oldText: out.oldText, newText: out.newText }];
			delete out.oldText;
			delete out.newText;
		}
		return out;
	};
}

export const normalizePiArgs = createPiArgumentNormalizer();

const NORMALIZER_SOURCE = `const __normalizePiArgs = (${createPiArgumentNormalizer.toString()})();`;

const GUEST_SETUP = `
(() => {
const __bridge = globalThis.__codeModeHostCall;
delete globalThis.__codeModeHostCall;
const __call = (ref, args) => __bridge(ref, args ?? {});
${NORMALIZER_SOURCE}

const __coreTools = ["read","bash","edit","write","grep","find","ls"];
const __stringPrimary = { bash: "command", read: "path", ls: "path", grep: "pattern", find: "pattern" };
const __positional = {
  grep: ["pattern", "path", "limit"],
  find: ["pattern", "path", "limit"],
  write: ["path", "content"],
};
// pi.read("a.ts", { limit: 10 }) and pi.grep("x", "src") both appear in the wild.
const __toArgs = (name, rest) => {
  const [first, second] = rest;
  const primary = __stringPrimary[name];
  if (rest.length === 2 && typeof first === "string" && primary &&
      second !== null && typeof second === "object" && !Array.isArray(second)) {
    return { ...second, [primary]: first };
  }
  const order = __positional[name];
  if (!order) return rest.length > 0 ? first : {};
  const out = {};
  for (let i = 0; i < rest.length && i < order.length; i++) {
    if (rest[i] !== undefined) out[order[i]] = rest[i];
  }
  return out;
};

// bash/edit/write resolve { ok, output, details }. The type checker suppresses
// property-miss errors, so result.trim() typechecks and then dies with QuickJS's
// terse "not a function". Name the fix instead.
const __envelopeTools = { bash: true, edit: true, write: true };
const __stringMethods = ["trim","split","includes","startsWith","endsWith","replace","replaceAll","slice","match","toLowerCase","toUpperCase","indexOf","length","padStart","padEnd","substring","concat","trimEnd","trimStart","search","matchAll","repeat"];
const __guardEnvelope = (name, value) => {
  if (value === null || typeof value !== "object" || typeof value.ok !== "boolean") return value;
  return new Proxy(value, {
    get(target, property, receiver) {
      if (typeof property === "string" && __stringMethods.indexOf(property) >= 0) {
        throw new TypeError(
          "pi." + name + "(...) resolves an envelope { ok, output, details }, not a string, so ." + property +
          " is unavailable. Read the text first: const out = (await pi." + name + "(...)).output;"
        );
      }
      return Reflect.get(target, property, receiver);
    },
  });
};

const __discovery = {
  list: (args = {}) => __call("$list", args),
  describe: (args) => __call("$describe", typeof args === "string" ? { ref: args } : args),
  call: (args) => __call("$call", args),
};

globalThis.pi = new Proxy(__discovery, {
  get(target, property) {
    if (property === "then" || typeof property === "symbol") return undefined;
    const name = String(property);
    if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
    return (...rest) => {
      const isCore = __coreTools.indexOf(name) >= 0;
      const raw = isCore && rest.length > 1
        ? __toArgs(name, rest)
        : (rest.length === 0 ? {} : rest[0]);
      const args = isCore ? __normalizePiArgs(name, raw === undefined ? {} : raw) : (raw ?? {});
      const promise = __call("pi." + name, args);
      return __envelopeTools[name] === true
        ? promise.then((value) => __guardEnvelope(name, value))
        : promise;
    };
  },
});

const __payloads = (typeof globalThis["π"] === "object" && globalThis["π"] !== null) ? globalThis["π"] : {};
globalThis["π"] = new Proxy(__payloads, {
  get(target, property) {
    if (typeof property === "symbol") return undefined;
    const name = String(property);
    if (name === "then" || name === "toJSON" || name === "constructor") return undefined;
    if (Object.prototype.hasOwnProperty.call(target, name)) return target[name];
    const provided = Object.keys(target);
    throw new Error(
      "π." + name + " is not defined. π only exposes keys from the payloads parameter" +
      (provided.length ? " (provided: " + provided.join(", ") + ")" : " (none provided)") +
      ". Pass payloads: { " + name + ": '...' } in the tool call."
    );
  },
  ownKeys(target) { return Reflect.ownKeys(target); },
  has(target, property) { return Object.prototype.hasOwnProperty.call(target, property); },
  getOwnPropertyDescriptor(target, property) {
    return Reflect.getOwnPropertyDescriptor(target, property);
  },
});
})();
`;

export const guestSetupSource = (): string => GUEST_SETUP;
