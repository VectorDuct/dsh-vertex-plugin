import z from "@deepseek-ai/schemastery";

/** Non-secret settings. Service-account JSON lives only in native Credentials. */
export interface VertexOptions {
  project?: string;
  location?: string;
  models?: Array<{
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
  }>;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  thinkingBudget?: number;
  includeThoughts?: boolean;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
}
export const Config = z.object({
  project: z.string().volatile(),
  location: z.string().volatile(),
  models: z
    .array(
      z.object({
        id: z.string().required(),
        name: z.string(),
        contextWindow: z.number().min(1).step(1),
        maxTokens: z.number().min(1).step(1),
      }),
    )
    .default([])
    .volatile(),
  maxOutputTokens: z.number().min(1).step(1).volatile(),
  temperature: z.number().min(0).max(2).volatile(),
  topP: z.number().min(0).max(1).volatile(),
  thinkingBudget: z.number().min(-1).step(1).volatile(),
  includeThoughts: z.boolean().volatile(),
  thinkingLevel: z.union(["minimal", "low", "medium", "high"]).volatile(),
});
export type Config = ReturnType<typeof Config>;
export function options(config: Config): VertexOptions {
  return Object.fromEntries(
    Object.entries(config).map(([key, value]) => [key, value.get()]),
  );
}
