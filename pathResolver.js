import RELATIONS from "./relations.js";

export function findPath(start, target) {
  if (start === target) return [start];

  const queue = [[start]];
  const visited = new Set([start]);

  while (queue.length) {
    const path = queue.shift();
    const node = path[path.length - 1];

    for (const r of RELATIONS) {
      const next =
        r.from === node ? r.to :
        r.to === node ? r.from :
        null;

      if (!next || visited.has(next)) continue;

      if (next === target) return [...path, next];

      visited.add(next);
      queue.push([...path, next]);
    }
  }
  return null;
}
