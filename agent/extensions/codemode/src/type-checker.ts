/**
 * Static gate: guest programs are type-checked against generated declarations
 * before they ever reach QuickJS, so bad code costs a diagnostic, not an effect.
 * Ported from pi-fabric src/runtime/type-checker.ts.
 */
import path from "node:path";
import ts from "typescript";

export interface GuestTypeError {
	line: number;
	column: number;
	message: string;
}

export interface GuestTypeCheckResult {
	errors: GuestTypeError[];
	javascript?: string;
}

const compilerOptions: ts.CompilerOptions = {
	target: ts.ScriptTarget.ES2022,
	module: ts.ModuleKind.ESNext,
	moduleResolution: ts.ModuleResolutionKind.NodeNext,
	strict: false,
	noImplicitAny: false,
	strictNullChecks: false,
	noEmit: false,
	skipLibCheck: true,
	lib: ["lib.es2022.d.ts"],
};

// Type-correctness noise the guest can survive at runtime: host results are
// dynamic JSON, so property-miss / assignability complaints would reject
// working programs. Shape mistakes still surface as runtime errors.
const SUPPRESSED_CODES = new Set<number>([
	2339, 2551, 2322, 2345, 2367, 2531, 2532, 18047, 18048, 7006, 7008, 7019, 7031, 7032, 7033,
	7034,
]);

/** User code starts on wrapped line 2. */
const wrapGuestCode = (code: string): string => `async function __codeModeMain() {\n${code}\n}\n`;

let nextCheckerId = 0;

class GuestTypeChecker {
	readonly #guestFile: string;
	readonly #declarationFile: string;
	readonly #baseHost = ts.createCompilerHost(compilerOptions, true);
	readonly #stableFiles = new Map<string, ts.SourceFile>();
	readonly #declarationSource: ts.SourceFile;
	readonly #host: ts.CompilerHost;
	#sourceText = "";
	#sourceFile: ts.SourceFile;
	#program: ts.Program | undefined;

	readonly declarations: string;

	constructor(declarations: string) {
		this.declarations = declarations;
		const id = ++nextCheckerId;
		const norm = (file: string): string => file.replaceAll("\\", "/");
		this.#guestFile = norm(path.resolve(`/__pi_codemode_guest_${id}.ts`));
		this.#declarationFile = norm(path.resolve(`/__pi_codemode_globals_${id}.d.ts`));
		this.#sourceFile = ts.createSourceFile(this.#guestFile, "", ts.ScriptTarget.ES2022, true);
		this.#declarationSource = ts.createSourceFile(
			this.#declarationFile,
			declarations,
			ts.ScriptTarget.ES2022,
			true,
		);
		const canonical = (file: string): string =>
			this.#baseHost.getCanonicalFileName(norm(file));
		const isGuest = (file: string): boolean => canonical(file) === canonical(this.#guestFile);
		const isDecl = (file: string): boolean =>
			canonical(file) === canonical(this.#declarationFile);
		this.#host = {
			...this.#baseHost,
			fileExists: (file) => isGuest(file) || isDecl(file) || this.#baseHost.fileExists(file),
			readFile: (file) => {
				if (isGuest(file)) return this.#sourceText;
				if (isDecl(file)) return this.declarations;
				return this.#baseHost.readFile(file);
			},
			getSourceFile: (file, languageVersion, onError, shouldCreate) => {
				if (isGuest(file)) return this.#sourceFile;
				if (isDecl(file)) return this.#declarationSource;
				const cached = this.#stableFiles.get(file);
				if (cached) return cached;
				const source = this.#baseHost.getSourceFile(
					file,
					languageVersion,
					onError,
					shouldCreate,
				);
				if (source) this.#stableFiles.set(file, source);
				return source;
			},
		};
	}

	check(code: string): GuestTypeCheckResult {
		this.#sourceText = wrapGuestCode(code);
		this.#sourceFile = ts.createSourceFile(
			this.#guestFile,
			this.#sourceText,
			ts.ScriptTarget.ES2022,
			true,
		);
		const program = ts.createProgram({
			rootNames: [this.#declarationFile, this.#guestFile],
			options: compilerOptions,
			host: this.#host,
			...(this.#program ? { oldProgram: this.#program } : {}),
		});
		this.#program = program;
		const diagnostics = [
			...program.getSyntacticDiagnostics(this.#sourceFile),
			...program
				.getSemanticDiagnostics(this.#sourceFile)
				.filter((diagnostic) => !SUPPRESSED_CODES.has(diagnostic.code)),
		];
		const errors = diagnostics.map((diagnostic) => {
			const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
			if (!diagnostic.file || diagnostic.start === undefined) {
				return { line: 0, column: 0, message };
			}
			const at = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
			// Wrapper occupies line 1, so the user's line is the wrapped line index.
			return { line: Math.max(1, at.line), column: at.character + 1, message };
		});
		if (errors.length > 0) return { errors };

		let javascript: string | undefined;
		program.emit(this.#sourceFile, (fileName, content) => {
			if (fileName.endsWith(".js")) javascript = content;
		});
		return { errors, ...(javascript ? { javascript } : {}) };
	}
}

const checkerCache = new Map<string, GuestTypeChecker>();
const MAX_CHECKERS = 4;

const checkerFor = (declarations: string): GuestTypeChecker => {
	const cached = checkerCache.get(declarations);
	if (cached) {
		checkerCache.delete(declarations);
		checkerCache.set(declarations, cached);
		return cached;
	}
	const checker = new GuestTypeChecker(declarations);
	checkerCache.set(declarations, checker);
	while (checkerCache.size > MAX_CHECKERS) {
		const oldest = checkerCache.keys().next().value as string | undefined;
		if (oldest === undefined) break;
		checkerCache.delete(oldest);
	}
	return checker;
};

export const typeCheckGuestCode = (code: string, declarations: string): GuestTypeCheckResult =>
	checkerFor(declarations).check(code);

export const transpileGuestCode = (code: string): string =>
	ts.transpileModule(wrapGuestCode(code), {
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
	}).outputText;
