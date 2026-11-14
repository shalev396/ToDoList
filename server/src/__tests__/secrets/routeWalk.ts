/**
 * Test-only: lists every route an Express 5 app registers, mounted sub-routers included.
 *
 * Express 5 keeps no mount path on a layer, only a compiled matcher. The prefix of a mount is
 * therefore recovered by probing the matcher with the candidate prefixes the caller supplies (the
 * checked-in manifest's paths and the exempt mounts). A mount that none of them matches is reported
 * as `unresolved`, which fails the suite with a message naming it.
 */

type Matcher = (path: string) => false | { path: string };

interface RouteLike {
  path: string;
  methods: Record<string, boolean>;
}

interface LayerLike {
  route?: RouteLike;
  handle: { stack?: LayerLike[] };
  matchers: Matcher[];
}

export interface WalkedRoute {
  method: string;
  /** Full path with `:param` placeholders, e.g. `/api/private/workspaces/:wid`. */
  path: string;
}

export interface WalkResult {
  routes: WalkedRoute[];
  /** Routes under a mount whose prefix is in `exempt`; listed for the report, never called. */
  exempted: WalkedRoute[];
  /** Mounts no candidate prefix matched: a route file mounted where the manifest knows nothing. */
  unresolved: string[];
}

function segmentPrefixes(path: string): string[] {
  const parts = path.split('/').filter((part) => part !== '');
  return parts.map((_, index) => `/${parts.slice(0, index + 1).join('/')}`);
}

function resolveMount(
  layer: LayerLike,
  parent: string,
  candidates: readonly string[],
): string | null {
  const matcher = layer.matchers[0];
  if (matcher === undefined) return null;
  // A mount on '/' matches every path, so it is tried first (and adds nothing to the prefix).
  if (matcher('/') !== false) return parent;
  const below = candidates
    .filter((candidate) => candidate.startsWith(`${parent}/`))
    .map((candidate) => candidate.slice(parent.length));
  const sorted = [...new Set(below)].sort((a, b) => a.length - b.length);
  const found = sorted.find((candidate) => matcher(candidate) !== false);
  return found === undefined ? null : `${parent}${found}`;
}

export function walkRoutes(
  app: unknown,
  knownPaths: readonly string[],
  exempt: readonly string[],
): WalkResult {
  const root = (app as { router: { stack: LayerLike[] } }).router.stack;
  const candidates = [...new Set([...knownPaths, ...exempt].flatMap(segmentPrefixes))];
  const result: WalkResult = { routes: [], exempted: [], unresolved: [] };

  const walk = (stack: LayerLike[], prefix: string, exempted: boolean): void => {
    for (const layer of stack) {
      if (layer.route !== undefined) {
        const methods = Object.entries(layer.route.methods)
          .filter(([, on]) => on)
          .map(([method]) => method.toUpperCase());
        for (const method of methods) {
          const path = `${prefix}${layer.route.path === '/' ? '' : layer.route.path}` || '/';
          (exempted ? result.exempted : result.routes).push({ method, path });
        }
      } else if (layer.handle.stack !== undefined) {
        const mount = resolveMount(layer, prefix, candidates);
        if (mount === null) {
          result.unresolved.push(`a router mounted under "${prefix || '/'}"`);
          continue;
        }
        const isExempt = exempted || exempt.some((entry) => mount === entry);
        walk(layer.handle.stack, mount, isExempt);
      }
    }
  };
  walk(root, '', false);
  return result;
}
