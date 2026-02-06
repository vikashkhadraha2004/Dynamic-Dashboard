import RELATIONS from "./relations.js";
import { findPath } from "./pathResolver.js";

function dedupe(arr, keyFn) {
  const seen = new Set();
  return arr.filter(i => {
    const k = keyFn(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function buildJoinPlan(root, filters) {
  let joins = [];

  for (const f of filters) {
    if (f.collection === root) continue;

    const path = findPath(root, f.collection);
    if (!path) continue;

    for (let i = 0; i < path.length - 1; i++) {
      const a = path[i];
      const b = path[i + 1];

      const rel = RELATIONS.find(
        r =>
          (r.from === a && r.to === b) ||
          (r.from === b && r.to === a)
      );

      joins.push({
        from: b,
        localField: rel.from === a ? rel.local : rel.foreign,
        foreignField: rel.from === a ? rel.foreign : rel.local,
        as: b
      });
    }
  }

  return dedupe(
    joins,
    j => `${j.from}:${j.localField}:${j.foreignField}`
  );
}
