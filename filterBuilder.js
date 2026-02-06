import OPERATORS from "./operators.js";

export function buildMatch(filters) {
  const match = {};

  for (const f of filters) {
    if (!OPERATORS[f.operator]) {
      throw new Error(`Invalid operator: ${f.operator}`);
    }

    const condition = OPERATORS[f.operator](f.value);

    if (!match[f.field]) match[f.field] = condition;
    else Object.assign(match[f.field], condition);
  }

  return match;
}
