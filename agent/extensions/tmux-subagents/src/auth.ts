/** Credential-only preflight: resolve/refresh auth, never send a model request. */
import { ModelRuntime, readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";

type Registry = ExtensionContext["modelRegistry"];

export async function preflightAuth(modelRef: string | undefined, registry: Registry, agentDir: string, parentAgentDir: string): Promise<void> {
  if (!modelRef) throw new Error("No model resolved for subagent.");
  const ref = modelRef.replace(/:(off|minimal|low|medium|high|xhigh|max)$/, "");
  const models = registry.getAll().filter((model) => `${model.provider}/${model.id}` === ref || model.id === ref);
  if (models.length !== 1) throw new Error(`Unknown or ambiguous subagent model: ${modelRef}`);
  const model = models[0];
  let auth;
  if (resolve(agentDir) === resolve(parentAgentDir)) {
    // Uses registered provider auth (including OAuth refresh), not hasConfiguredAuth.
    auth = await registry.getProviderAuth(model.provider);
  } else {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const native = registry.getRegisteredNativeProvider(model.provider);
    const config = registry.getRegisteredProviderConfig(model.provider);
    if (native) runtime.registerNativeProvider(native);
    if (config) runtime.registerProvider(model.provider, config);
    auth = await runtime.getAuth(model.provider);
  }
  const stored = readStoredCredential(model.provider, join(agentDir, "auth.json"));
  // A refresh callback may return its unchanged token; don't acknowledge a known-expired child.
  if (!auth || (stored?.type === "oauth" && (!Number.isFinite(stored.expires) || stored.expires <= Date.now()))) {
    throw new Error(`No usable credential for provider "${model.provider}" (missing, expired, or refresh unavailable).`);
  }
}
