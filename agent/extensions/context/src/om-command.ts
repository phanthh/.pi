/**
 * /context — status, settings, reload for the observational memory layer.
 * Pi has no extension hook into the built-in /settings UI, so settings live here.
 */
import { getSettingsListTheme, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import { globalConfigPath, saveGlobalConfig, type OmConfig } from "./config.ts";
import type { OmRuntime } from "./om.ts";

const NUMERIC_PRESETS: Partial<Record<keyof OmConfig, number[]>> = {
  observeAfterTokens: [10_000, 15_000, 20_000, 40_000],
  reflectAfterTokens: [10_000, 25_000, 40_000, 80_000],
  observationsPoolMaxTokens: [3_000, 10_000, 20_000, 40_000],
  reflectionsPoolMaxTokens: [2_000, 4_000, 8_000, 16_000],
};

const onOff = (value: boolean): string => (value ? "on" : "off");

const buildItems = (config: OmConfig): SettingItem[] => [
  { id: "enabled", label: "OM pipeline enabled", currentValue: onOff(config.enabled), values: ["on", "off"] },
  {
    id: "sessionFallback",
    label: "Use session model when none configured",
    currentValue: onOff(config.sessionFallback),
    values: ["on", "off"],
  },
  {
    id: "observeAfterTokens",
    label: "Observe after (tokens)",
    currentValue: String(config.observeAfterTokens),
    values: NUMERIC_PRESETS.observeAfterTokens!.map(String),
  },
  {
    id: "reflectAfterTokens",
    label: "Reflect/drop after (tokens)",
    currentValue: String(config.reflectAfterTokens),
    values: NUMERIC_PRESETS.reflectAfterTokens!.map(String),
  },
  {
    id: "observationsPoolMaxTokens",
    label: "Observation pool budget (tokens)",
    currentValue: String(config.observationsPoolMaxTokens),
    values: NUMERIC_PRESETS.observationsPoolMaxTokens!.map(String),
  },
  {
    id: "reflectionsPoolMaxTokens",
    label: "Reflection output budget (tokens)",
    currentValue: String(config.reflectionsPoolMaxTokens),
    values: NUMERIC_PRESETS.reflectionsPoolMaxTokens!.map(String),
  },
];

const applySetting = (id: string, value: string): Partial<OmConfig> | null => {
  if (id === "enabled" || id === "sessionFallback") return { [id]: value === "on" };
  if (id === "observeAfterTokens" || id === "reflectAfterTokens" || id === "observationsPoolMaxTokens" || id === "reflectionsPoolMaxTokens") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? { [id]: parsed } : null;
  }
  return null;
};

export const handleOmCommand = async (
  action: "status" | "settings" | "reload",
  ctx: ExtensionCommandContext,
  om: OmRuntime,
): Promise<void> => {
  if (action === "reload") {
    const config = om.reload(ctx);
    ctx.ui.notify(`context: config reloaded (OM pipeline ${onOff(config.enabled)})`, "info");
    return;
  }

  if (action === "settings") {
    if (ctx.mode !== "tui") {
      ctx.ui.notify(`context: edit ${globalConfigPath()} then run /context reload`, "info");
      return;
    }
    await ctx.ui.custom((_tui, theme, _kb, done) => {
      const container = new Container();
      container.addChild(new Text(theme.fg("accent", theme.bold("Context / observational memory")), 1, 1));
      const items = buildItems(om.getConfig());
      const list = new SettingsList(
        items,
        Math.min(items.length + 2, 15),
        getSettingsListTheme(),
        (id, value) => {
          const patch = applySetting(id, value);
          if (!patch) return;
          saveGlobalConfig(patch);
          om.reload(ctx);
        },
        () => done(undefined),
      );
      container.addChild(list);
      return {
        render: (w) => container.render(w),
        invalidate: () => container.invalidate(),
        handleInput: (data) => list.handleInput?.(data),
      };
    });
    ctx.ui.notify(`context: saved to ${globalConfigPath()}`, "info");
    return;
  }

  ctx.ui.notify(`context\n${om.status(ctx)}\nconfig: ${globalConfigPath()}`, "info");
};
