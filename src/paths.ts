import { isAbsolute, relative, sep } from "node:path";

export type Containment = "inside" | "root" | "outside";

/**
 * Whether `candidate` sits under `root`, is `root` itself, or is neither. Lexical only: a caller that
 * cares where a symlink leads passes `realpath`ed paths on both sides. Shared by the two boundaries
 * the plugin enforces — `downloadDir` at startup and `uploadRoot` on every attachment — which agree
 * on the rule and on nothing else: the phrasing of a refusal, and what else disqualifies a path,
 * stays with the callers, since one of them is a config line and the other a tool argument.
 */
export function contains(root: string, candidate: string): Containment {
  const rel = relative(root, candidate);
  if (!rel) return "root";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "outside";
  return "inside";
}
