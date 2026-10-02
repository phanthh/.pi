import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadRecentPrompts } from "./history.ts";

type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export default function upHistory(pi: ExtensionAPI, load = loadRecentPrompts): void {
	let generation = 0;
	let release = () => {};

	pi.on("session_start", (_event, ctx) => {
		const current = ++generation;
		release();
		if (ctx.mode !== "tui" || !ctx.hasUI) return;

		const previous = ctx.ui.getEditorComponent();
		let active: ReturnType<EditorFactory> | undefined;
		let prompts: string[] = [];
		const seeded = new WeakSet<object>();
		const seed = (editor: ReturnType<EditorFactory>) => {
			if (current !== generation || !prompts.length || seeded.has(editor) || !editor.addToHistory) return;
			for (let i = prompts.length - 1; i >= 0; i--) editor.addToHistory(prompts[i]);
			seeded.add(editor);
		};
		const factory: EditorFactory = (tui, theme, keybindings) => {
			const editor = previous ? previous(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
			active = editor;
			seed(editor);
			return editor;
		};
		release = () => {
			active = undefined;
			prompts = [];
		};
		// Pi transfers current text and app callbacks when installing a factory.
		ctx.ui.setEditorComponent(factory);
		void load(ctx.sessionManager.getSessionDir(), ctx.cwd).then((loaded) => {
			if (current !== generation || ctx.ui.getEditorComponent() !== factory) return;
			prompts = loaded;
			if (active) seed(active);
		}).catch(() => {});
	});

	pi.on("session_shutdown", () => {
		generation++;
		release();
	});
}
