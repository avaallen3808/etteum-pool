/**
 * Claude Desktop (3rd-party inference gateway) config generator.
 *
 * Claude Desktop supports custom inference gateways through the
 * `~/.config/Claude-3p/configLibrary/` directory: each JSON file is a named
 * gateway profile, and `_meta.json` tracks the applied entry. This generator
 * writes an etteum pool profile and marks it applied.
 */
import { join } from "node:path";
import { homedir } from "node:os";
import type { ProxyConnectionInfo, ClientConfigResult } from "../types";
import { readJsonObject, writeJsonObject } from "./utils";

export async function configureClaudeDesktop(
  info: ProxyConnectionInfo
): Promise<Omit<ClientConfigResult, "client">> {
  const dir = join(homedir(), ".config", "Claude-3p", "configLibrary");
  const profilePath = join(dir, "etteum.json");
  const metaPath = join(dir, "_meta.json");

  const profile = {
    inferenceGatewayBaseUrl: info.proxyOrigin,
    inferenceGatewayApiKey: info.apiKey,
    inferenceGatewayAuthScheme: "x-api-key",
    inferenceProvider: "gateway",
    inferenceCredentialKind: "static",
  };

  try {
    if (info.preview) {
      return {
        success: true,
        preview: {
          profile,
          meta: {
            appliedId: "etteum",
            entries: [{ id: "etteum", name: "Etteum Pool" }],
          },
        },
        paths: [profilePath, metaPath],
        backupPaths: [],
      };
    }

    // Preserve existing entries, then upsert the etteum one.
    const meta = await readJsonObject(metaPath);
    const entries = Array.isArray(meta.entries)
      ? (meta.entries as Array<Record<string, unknown>>).filter(
          (e) => e && e.id !== "etteum"
        )
      : [];
    entries.push({ id: "etteum", name: "Etteum Pool" });
    const nextMeta = { appliedId: "etteum", entries };

    const backupPaths = [
      ...(await writeJsonObject(profilePath, profile)),
      ...(await writeJsonObject(metaPath, nextMeta)),
    ];

    return {
      success: true,
      preview: { profile, meta: nextMeta },
      paths: [profilePath, metaPath],
      backupPaths,
    };
  } catch (error) {
    return {
      success: false,
      paths: [profilePath, metaPath],
      backupPaths: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
